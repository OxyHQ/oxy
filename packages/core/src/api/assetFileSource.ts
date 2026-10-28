/** Platform file access supplied by the native SDK; core imports no native module. */
export interface AssetFilePartRequest {
  url: string;
  start: number;
  end: number;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress: (loaded: number) => void;
}

export interface AssetFileSource {
  readonly size: number;
  /** Read only this bounded range; never materialize the entire file. */
  readRange(start: number, end: number): Promise<Uint8Array>;
  /** Stream a file range to its signed storage URL, without application credentials. */
  putPart(request: AssetFilePartRequest): Promise<{ ok: true } | { ok: false; status: number }>;
}

export type AssetFileAdapter = (uri: string) => Promise<AssetFileSource>;

export function isAssetFileSource(source: Blob | AssetFileSource): source is AssetFileSource {
  return 'readRange' in source && 'putPart' in source;
}
