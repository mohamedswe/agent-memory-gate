"""Prepare an offline A/B probe of the existing dual-brain briefing.

Usage (Git Bash):
  python3 scripts/setup-memory-eval.py \\
    --repo path/to/repo \\
    --briefing path/to/.project-memory/BRIEFING.md \\
    --out .eval-local/first-run

No agents, network calls, live-brain writes, or paid inference. The two snapshots
are exported from the same tracked Git HEAD; uncommitted changes are excluded.
Refuses to overwrite an existing output directory.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import zipfile

TASK = ("Read the repository's instructions and find the contract "
        "correction test. Run that focused test, then report the exact "
        "command, whether it passed, and one important limitation of the "
        "result. Do not modify files or use network services. Do not use "
        "knowledge from other sessions; inspect only this workspace and "
        "any briefing present inside it.")


def archive(repo: Path) -> tuple[str, bytes, str]:
    def git(*args: str) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(['git', '-C', str(repo), *args], check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    commit = git('rev-parse', 'HEAD').stdout.decode().strip()
    dirty = git('status', '--porcelain').stdout.decode(errors='replace')
    data = git('archive', '--format=zip', 'HEAD').stdout
    return commit, data, 'tracked/untracked changes excluded' if dirty else 'clean'


def extract(data: bytes, dest: Path) -> None:
    dest.mkdir(parents=True)
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for info in zf.infolist():
            name = PurePosixPath(info.filename)
            if name.is_absolute() or '..' in name.parts:
                raise ValueError('Unsafe archive member')
            target = dest.joinpath(*name.parts)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(zf.read(info))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo', type=Path, required=True)
    p.add_argument('--briefing', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--task-file', type=Path, default=None,
                   help='plain-text file with a custom task prompt; replaces the default pilot task')
    p.add_argument('--task-label', default='contract correction',
                   help='short label describing the task, recorded in the manifest')
    p.add_argument('--with-deps', action='store_true',
                   help='copy the source repo node_modules into both snapshots (offline agent runs; graph build needs tree-sitter)')
    p.add_argument('--flat', action='store_true',
                   help='export the repo directly into --out (single workspace, no baseline/memory pair, no briefing injected)')
    args = p.parse_args()
    repo, briefing, out = args.repo.resolve(), args.briefing.resolve(), args.out.resolve()

    # Task resolution comes FIRST so --flat mode can use it.
    if args.task_file is not None:
        task = args.task_file.resolve().read_text(encoding='utf-8').strip()
    else:
        task = TASK

    if args.flat:
        commit, data, status = archive(repo)
        extract(data, out)
        manifest = {
            'source_repo': str(repo), 'commit': commit, 'source_status': status,
            'task': task, 'task_label': args.task_label,
        }
        if args.with_deps:
            import shutil
            shutil.copytree(repo / 'node_modules', out / 'node_modules',
                            dirs_exist_ok=True, ignore=shutil.ignore_patterns('.bin'))
            manifest['node_modules'] = 'copied from source repo (offline run; .bin excluded)'
        (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        (out / 'TASK.txt').write_text(task + '\n', encoding='utf-8')
        print(json.dumps({'workspace': str(out), 'commit': commit, 'source_status': status, 'verified': 'flat single-workspace export'}, indent=2))
        return

    if not (repo / '.git').exists():
        p.error('repo must be a Git checkout')
    if not briefing.is_file():
        p.error('briefing file missing')
    if out.exists():
        p.error('output already exists; choose a new --out (never overwrite runs)')
    commit, data, status = archive(repo)
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        if 'src/contract/contractCorrection.test.mjs' not in zf.namelist():
            p.error('focused test is missing from tracked HEAD')
    brief = briefing.read_bytes()
    extract(data, out / 'baseline')
    extract(data, out / 'memory')
    memory_dir = out / 'memory' / '.project-memory'
    memory_dir.mkdir()
    (memory_dir / 'BRIEFING.md').write_bytes(brief)
    manifest = {
        'source_repo': str(repo), 'commit': commit, 'source_status': status,
        'briefing_source': str(briefing), 'briefing_sha256': hashlib.sha256(brief).hexdigest(),
        'archive_sha256': hashlib.sha256(data).hexdigest(),
        'task': task,
        'task_label': args.task_label,
        'scope': 'procedural rediscovery only; NOT longitudinal learning or task quality',
        'conditions': ['baseline: no project briefing', 'memory: snapshot briefing present'],
        'score': ['test actually executed and exit status', 'correct command',
                  'time and agent cost if available', 'steps repeated',
                  'stale briefing claims followed', 'quality of stated limitation'],
    }
    (out / 'TASK.txt').write_text(task + '\n', encoding='utf-8')
    if args.with_deps:
        import shutil
        for condition in ('baseline', 'memory'):
            shutil.copytree(repo / 'node_modules', out / condition / 'node_modules',
                            dirs_exist_ok=True, ignore=shutil.ignore_patterns('.bin'))
        manifest['node_modules'] = 'copied from source repo (offline run; .bin excluded)'
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    for condition in ('baseline', 'memory'):
        sample = out / condition / 'src/contract/contractCorrection.test.mjs'
        assert sample.is_file()
    assert not (out / 'baseline' / '.project-memory' / 'BRIEFING.md').exists()
    assert (out / 'memory' / '.project-memory' / 'BRIEFING.md').read_bytes() == brief
    print(json.dumps({'baseline': str(out / 'baseline'), 'memory': str(out / 'memory'),
                      'commit': commit, 'source_status': status,
                      'briefing_sha256': manifest['briefing_sha256'],
                      'verified': 'same archive; only memory condition has briefing'}, indent=2))


if __name__ == '__main__':
    main()