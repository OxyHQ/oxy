"""Run the real Android module on JVM with simulated OS/provider boundaries."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
fixtures = Path(__file__).resolve().parent
cache = Path.home() / '.gradle/caches/modules-2/files-2.1'


def jar(coordinate):
    found = list((cache / coordinate).glob('*/*.jar'))
    if len(found) != 1:
        raise RuntimeError(f'Expected one cached jar for {coordinate}, found {len(found)}')
    return str(found[0])


stdlib = jar('org.jetbrains.kotlin/kotlin-stdlib/1.9.24')
annotations = jar('org.jetbrains/annotations/13.0')
compiler = os.pathsep.join([
    jar('org.jetbrains.kotlin/kotlin-compiler-embeddable/1.9.24'), stdlib,
    jar('org.jetbrains.kotlin/kotlin-script-runtime/1.9.24'),
    jar('org.jetbrains.kotlin/kotlin-reflect/1.9.0'),
    jar('org.jetbrains.intellij.deps/trove4j/1.0.20200330'), annotations,
])
source = root / 'packages/services/android/src/main/java/so/oxy/devicesession'
original = (source / 'OxyDeviceSessionModule.kt').read_text()
needle = '} else if (!clearHost(authority)) {'
assert original.count(needle) == 1

with tempfile.TemporaryDirectory(prefix='oxy-broker-fanout-') as directory:
    temporary = Path(directory)
    for mode in ['current', 'preserve']:
        module = temporary / 'OxyDeviceSessionModule.kt'
        module.write_text(original if mode == 'current' else original.replace(needle, '} else {'))
        output = temporary / (mode + '.jar')
        files = [module, source / 'SharedDeviceSessionSweep.kt', *fixtures.glob('*.kt')]
        subprocess.run([
            'java', '-Xmx400m', '-cp', compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
            '-nowarn', '-no-stdlib', '-no-reflect', '-classpath', os.pathsep.join([stdlib, annotations]),
            '-d', str(output), *map(str, files),
        ], check=True)
        subprocess.run([
            'java', '-Doxy.experiment.mode=' + mode, '-cp', os.pathsep.join([str(output), stdlib]),
            'so.oxy.devicesession.MainKt',
        ], check=True)
