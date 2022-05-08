import CryptoJS from "crypto-js";

function array_buffer_to_word_array(ab: ArrayBuffer) {
	let i8a = new Uint8Array(ab);
	let a = [];
	for (let i = 0; i < i8a.length; i += 4) {
		a.push((i8a[i] << 24) | (i8a[i + 1] << 16) | (i8a[i + 2] << 8) | i8a[i + 3]);
	}
	return CryptoJS.lib.WordArray.create(a, i8a.length);
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export class KekUploadAPI {
	readonly base: string;

	/**
	 * Create a new KekUploadAPI instance.
	 *
	 * @param base The base URL of the KekUpload API
	 *
	 * ```typescript
	 * const api = new KekUploadAPI("https://u.kotw.dev/api/");
	 * ```
	 */
	constructor(base: string) {
		this.base = base;
	}

	async req(method: HttpMethod, path: string, data: ArrayBuffer | null): Promise<any> {
		return new Promise((resolve, reject) => {
			let xmlHttp = new XMLHttpRequest();
			xmlHttp.onreadystatechange = function () {
				if (xmlHttp.readyState === 4) {
					(xmlHttp.status === 200 ? resolve : reject)(JSON.parse(xmlHttp.response));
				}
			};
			xmlHttp.open(method, `${this.base}${path}`, true);
			xmlHttp.send(data);
		});
	}

	async create(ext: string): Promise<{ stream: string }> {
		return await this.req("POST", `c/${ext}`, null);
	}

	async upload(stream: string, hash: string, chunk: ArrayBuffer): Promise<{ success: boolean }> {
		return await this.req("POST", `u/${stream}/${hash}`, chunk);
	}

	async finish(stream: string, hash: string): Promise<{ id: string }> {
		return await this.req("POST", `f/${stream}/${hash}`, null);
	}

	async remove(stream: string): Promise<{ success: boolean }> {
		return await this.req("POST", `r/${stream}`, null);
	}
}

export type ChunkedUploaderOptions = {
	api: KekUploadAPI;
};

export class ChunkedUploader {
	private readonly api: KekUploadAPI;
	private readonly hasher: any;
	private stream: string | undefined;

	/**
	 * Create a new ChunkedUploader.
	 *
	 * @param options The options passed to the constructor.
	 *
	 * ```typescript
	 * // Create a new ChunkedUploader
	 * const uploader = new ChunkedUploader({
	 *     api: new KekUploadAPI("https://u.kotw.dev/api/")
	 * });
	 * ```
	 */
	constructor(options: ChunkedUploaderOptions) {
		this.hasher = CryptoJS.algo.SHA1.create();
		this.api = options.api;
	}

	/**
	 * Initialize a stream.
	 *
	 * @param ext The file extension
	 *
	 * ```typescript
	 * // Initialize the stream
	 * await uploader.begin("txt");
	 * ```
	 */
	async begin(ext: string): Promise<void> {
		this.stream = (await this.api.create(ext)).stream;
	}

	/**
	 * Upload a chunk to the stream. You have to run {@link begin} first to initialize the stream.
	 *
	 * @param chunk The chunk to upload
	 * @returns The hash of the chunk
	 * @throws Throws an error if the stream is not initialized
	 *
	 * ```typescript
	 * const text = "I ❤️ KekUpload";
	 *
	 * // Convert string to ArrayBuffer
	 * const my_chunk = Uint8Array.from(text, x => x.charCodeAt(0));
	 *
	 * // Upload the chunk
	 * const hash = await uploader.upload(chunk);
	 *
	 * // Print out the hash of 'my_chunk'
	 * console.log(hash);
	 * ```
	 */
	upload(chunk: ArrayBuffer): Promise<string> {
		return new Promise(async (resolve, reject) => {
			if (this.stream === undefined) reject("Stream not initialized. Have you ran 'begin' yet?");

			const word_array = array_buffer_to_word_array(chunk);
			const hash = CryptoJS.SHA1(word_array).toString();
			this.hasher.update(word_array);

			// Try uploading chunk until it succeeds
			while (true) {
				try {
					await this.api.upload(this.stream as string, hash, chunk);
					break;
				} catch (e) {}
			}

			resolve(hash);
		});
	}

	/**
	 * Finish the stream. You have to run {@link begin} first to initialize the stream.
	 *
	 * @returns An object containing the id and hash of the uploaded file
	 * @throws Throws an error if the stream is not initialized
	 *
	 * ```typescript
	 * // Finish the stream
	 * const {id, hash} = await uploader.finish();
	 * ```
	 */
	async finish(): Promise<{ id: string; hash: string }> {
		if (this.stream === undefined)
			throw new Error("Stream not initialized. Have you ran 'begin' yet?");

		const hash = this.hasher.finalize().toString();
		const { id } = await this.api.finish(this.stream as string, hash);

		return { id, hash };
	}

	/**
	 * This will destroy the stream. The file will **NOT** be published. You have to run {@link begin} first to initialize the stream.
	 *
	 * @throws Throws an error if the stream is not initialized
	 *
	 * ```typescript
	 * // Destroy the stream to cancel an upload
	 * await uploader.destroy();
	 * ```
	 */
	async destroy(): Promise<void> {
		if (this.stream === undefined)
			throw new Error("Stream not initialized. Have you ran 'begin' yet?");

		await this.api.remove(this.stream as string);
	}
}

export type FileUploaderOptions = ChunkedUploaderOptions & {
	read_size?: number;
	chunk_size?: number;
};

export class FileUploader extends ChunkedUploader {
	private readonly read_size: number;
	private readonly chunk_size: number;
	private cancel_cb?: () => void;
	private uploading: boolean = false;

	/**
	 * Create a new FileUploader.
	 *
	 * @param options The options passed to the constructor.
	 *
	 * ```typescript
	 * // Create a new FileUploader
	 * const uploader = new FileUploader({
	 *     api: new KekUploadAPI("https://u.kotw.dev/api/")
	 * });
	 * ```
	 */
	constructor(options: FileUploaderOptions) {
		super(options);

		// Default 32 MiB
		this.read_size = options.read_size || 33554432;
		// Default 2 MiB
		this.chunk_size = options.chunk_size || 2097152;
	}

	/**
	 * Upload the file. You have to run {@link begin} first to initialize the stream.
	 *
	 * @param file The file to upload
	 * @param on_progress A callback which will be called when the upload progressses
	 *
	 * @throws Throws an error if the stream is not initialized
	 * @throws Throws an error if {@link cancel} was called
	 *
	 * ```typescript
	 * // Initialize the stream
	 * await uploader.begin("txt");
	 *
	 * // Upload the file
	 * await uploader.uploadFile(file);
	 *
	 * // Finish the stream
	 * const {id, hash} = await uploader.finish();
	 *
	 * // Print out the id and hash of the uploaded file
	 * console.log(id, hash);
	 * ```
	 */
	async upload_file(file: File, on_progress: (progress: number) => void): Promise<void> {
		this.uploading = true;

		for (let i = 0; i < file.size; i += this.read_size) {
			await new Promise((resolve, reject) => {
				// Take a slice of the file with size of our read_size
				const slice = file.slice(i, i + this.read_size);

				const reader = new FileReader();
				reader.onload = async (e) => {
					const result = (e.target as FileReader).result as ArrayBuffer;

					for (let f = 0; f < result.byteLength; f += this.chunk_size) {
						if (this.cancel_cb) {
							await this.destroy().catch();
							reject("CANCELLED");
							this.cancel_cb();
							return;
						}

						// Take a chunk of the slice with size of our chunk_size
						const chunk = result.slice(f, f + this.chunk_size);

						// Upload the chunk
						await this.upload(chunk);

						on_progress((i + f) / file.size);

						resolve(undefined);
					}
				};

				reader.readAsArrayBuffer(slice);
			});
		}

		this.uploading = false;
	}

	/**
	 * Cancel the file upload. You have to run {@link upload_file} first.
	 *
	 * @throws Throws an error if not uploading
	 *
	 * ```typescript
	 * // Initialize the stream
	 * await uploader.begin("txt");
	 *
	 * // Upload the file
	 * uploader.uploadFile(file).catch(e => {
	 *    if(e === "CANCELLED") console.log("Upload got canceled!");
	 * });
	 *
	 * setTimeout(() => {
	 *    // Cancel the upload
	 *    uploader.cancel();
	 * }, 1000);
	 * ```
	 */
	cancel(): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.uploading) reject("Not uploading. Have you ran 'upload_file' yet?");

			this.cancel_cb = resolve;
		});
	}
}

export type FileUploaderQueuedOptions = FileUploaderOptions & {};

export type FileUploaderQueuedJob = {
	file: File;
	ext: string;
	then: (value: { id: string; hash: string }) => void;
	catch: (err: any) => void;
	finally: () => void;
	on_progress: (progress: number) => void;
};

export class FileUploaderQueued extends FileUploader {
	private readonly jobs: { [key: number]: FileUploaderQueuedJob } = {};
	private readonly queue: number[] = [];
	private queue_index: number = 0;

	private running: number = 0;
	private active: number = -1;

	/**
	 * Create a new FileUploaderQueued.
	 *
	 * @param options The options passed to the constructor.
	 *
	 * ```typescript
	 * // Create a new FileUploaderQueued
	 * const uploader = new FileUploaderQueued({
	 *     api: new KekUploadAPI("https://u.kotw.dev/api/")
	 * });
	 * ```
	 */
	constructor(options: FileUploaderQueuedOptions) {
		super(options);
	}

	/**
	 * Add a job to the queue.
	 *
	 * @param job The job to add to the queue
	 * @returns The job id which can be used to cancel the job
	 *
	 * ```typescript
	 * // Add a job to the queue
	 * const id = uploader.addJob({
	 *     file: file,
	 *     ext: "txt",
	 *     then: ({id, hash}) => {
	 *         console.log(id, hash);
	 *     },
	 *     catch: (e) => {
	 *         if(e === "CANCELLED") console.log("Upload got canceled!");
	 *         else console.err(e);
	 *     },
	 *     finally: () => {
	 *         // Same as Promise::finally
	 *         console.log("This will be executed even if there was an error");
	 *     },
	 *     on_progress: (progress) => {
	 *        console.log(`uploading: ${(progress*100).toFixed(1)}%`);
	 *     }
	 * });
	 * ```
	 */
	add_job(job: FileUploaderQueuedJob): number {
		const id = this.queue_index++;
		this.jobs[id] = job;
		this.queue.push(id);

		this.work();

		return id;
	}

	/**
	 * Cancel a job which has been added to the queue.
	 *
	 * @throws Throws an error if the job with the given id is not in the queue
	 *
	 * @param job_id The job_id which you get by calling {@link add_job}
	 *
	 * ```typescript
	 * // Cancel job
	 * uploader.cancel_job(job_id);
	 * ```
	 */
	async cancel_job(job_id: number): Promise<void> {
		if (this.active === job_id) {
			await this.cancel();
		} else {
			if (!this.jobs[job_id]) throw new Error("Job not found");

			delete this.jobs[job_id];
			this.queue.splice(this.queue.indexOf(job_id), 1);
		}
	}

	private async work() {
		// Check if it is not running
		if (this.running++ === 0) {
			// Iterate over the entire queue
			for (let job_id = this.queue.shift(); job_id; job_id = this.queue.shift()) {
				this.active = job_id;
				const job = this.jobs[job_id];
				delete this.jobs[job_id];

				await this.begin(job.ext);
				await this.upload_file(job.file, job.on_progress);

				try {
					await this.finish().then(job.then).catch(job.catch);
				} catch (ignored) {}

				job.finally();
			}

			this.running = 0;
		}
	}
}
