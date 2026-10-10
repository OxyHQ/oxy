import { test, expect, describe } from 'bun:test';
import { sha256Hex, md5Hex, contentTypeForExt } from '../hash';

describe('hash helpers', () => {
  test('sha256Hex matches known vectors', () => {
    expect(sha256Hex(Buffer.from('hello'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(sha256Hex(Buffer.from(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  test('md5Hex matches known vectors', () => {
    expect(md5Hex(Buffer.from('hello'))).toBe('5d41402abc4b2a76b9719d911017c592');
    expect(md5Hex(Buffer.from('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  test('contentTypeForExt maps known types and falls back', () => {
    expect(contentTypeForExt('png')).toBe('image/png');
    expect(contentTypeForExt('.PNG')).toBe('image/png');
    expect(contentTypeForExt('js')).toBe('application/javascript');
    expect(contentTypeForExt('ttf')).toBe('font/ttf');
    expect(contentTypeForExt('mystery')).toBe('application/octet-stream');
  });
});
