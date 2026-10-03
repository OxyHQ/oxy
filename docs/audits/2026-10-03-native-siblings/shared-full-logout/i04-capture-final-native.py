from pathlib import Path
import urllib.request, json, hashlib, concurrent.futures, re
out = Path('/home/nate/Oxy/.agent-evidence')
def capture(item):
    name, port = item
    request = urllib.request.Request(f'http://127.0.0.1:{port}/', headers={'expo-platform': 'android', 'accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=90) as response:
        manifest = json.load(response)
    (out / f'i04-native-{name}-full-logout-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    launch = manifest['launchAsset']['url']
    record = {'variant': name, 'port': port, 'launchUrl': launch}
    for mode, url in [('full', launch.replace('lazy=true', 'lazy=false').replace('transform.bytecode=1', 'transform.bytecode=0')), ('launch', launch)]:
        with urllib.request.urlopen(url, timeout=120) as response:
            data = response.read()
        assert b'acceptance-profile-sequence' in data
        assert re.search(rb'async function readProfile\(\).*?cache\.delete\([\"\x27]GET:/users/me[\"\x27]\).*?await oxyServices\.users\.me\(\).*?setProfileSequence', data, re.S), 'served entry must invalidate before the successful SDK read and counter'
        path = out / f'i04-native-{name}-full-logout-{mode}.bundle.js'
        path.write_bytes(data)
        record[mode] = {'path': str(path), 'url': url, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
    return record
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    results = list(pool.map(capture, [('mention', 17967), ('allo', 17968)]))
(out / 'i04-native-full-logout-bundles-final.json').write_text(json.dumps(results, indent=2) + '\n')
print([(record['variant'], record['launch']['sha256']) for record in results])
