declare module 'expo-crypto' {
  export enum CryptoDigestAlgorithm {
    SHA1 = 'SHA1',
    SHA256 = 'SHA256',
    SHA384 = 'SHA384',
    SHA512 = 'SHA512',
    MD5 = 'MD5',
    MD2 = 'MD2',
    MD4 = 'MD4',
  }

  export function digestStringAsync(
    algorithm: CryptoDigestAlgorithm | 'MD5' | 'SHA1' | 'SHA256' | 'SHA384' | 'SHA512',
    data: string,
    options?: { encoding?: 'base64' | 'hex' },
  ): Promise<string>;

  export function digestString(
    algorithm: CryptoDigestAlgorithm | 'MD5' | 'SHA1' | 'SHA256' | 'SHA384' | 'SHA512',
    data: string,
    options?: { encoding?: 'base64' | 'hex' },
  ): string;

  export function getRandomBytes(byteCount: number): Uint8Array;
  export function getRandomBytesAsync(byteCount: number): Promise<Uint8Array>;
  export function randomUUID(): string;
}
