/** Check the actual published pair, independently of unreleased workspace majors. */
export async function assertPublishedBloomPair(resolved, readRegistryJson) {
  const services = [...resolved].filter(([spec]) => spec.startsWith('@oxy.so/services@'));
  const blooms = [...resolved].filter(([spec]) => spec.startsWith('@oxy.so/bloom@'));
  if (services.length && !blooms.length) throw new Error('Services scaffold has no explicit Bloom dependency');
  for (const [, version] of services) {
    const peers = await readRegistryJson(`@oxy.so/services@${version}`, 'peerDependencies');
    const range = peers?.['@oxy.so/bloom'];
    if (typeof range !== 'string') throw new Error(`Services ${version} has no Bloom peer range`);
    // Let npm evaluate semver, including unions, using the public versions it
    // already resolves for installs. A registry failure must fail the gate.
    const matches = await readRegistryJson(`@oxy.so/bloom@${range}`, 'version');
    const allowed = Array.isArray(matches) ? matches : [matches];
    for (const [spec, bloomVersion] of blooms) {
      if (!allowed.includes(bloomVersion)) {
        throw new Error(`${spec} resolves to ${bloomVersion}, outside Services ${version}'s Bloom peer ${range}`);
      }
    }
  }
}
