import {
  attestWorkloadIdentity,
  canAttestWorkloadIdentity,
  requestWorkloadServiceToken,
} from '../workloadIdentity.client';

describe('client workload identity boundary', () => {
  it('cannot attest even when Node process globals are present', () => {
    expect(process.versions.node).toBeTruthy();
    expect(canAttestWorkloadIdentity()).toBe(false);
  });

  it('rejects before contacting a server when explicitly requested', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(requestWorkloadServiceToken({ baseUrl: 'https://example.test' })).rejects.toThrow(
      'only available on a Node host',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('never signs an attestation off a Node host', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(attestWorkloadIdentity({ nonce: 'nonce' })).rejects.toThrow(
      'only available on a Node host',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
