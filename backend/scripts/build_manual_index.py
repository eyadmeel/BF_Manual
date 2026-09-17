"""매뉴얼 인덱스 생성 스크립트 (로컬 전용 — 배포 런타임에서 실행하지 않는다).

backend/app/data/manuals/*.md  →  backend/app/data/manual_index.json

사용 (저장소 루트에서):
  python backend/scripts/build_manual_index.py --check   # 형식 검사만. 키·네트워크 불필요, 파일을 쓰지 않음
  python backend/scripts/build_manual_index.py           # 검사 통과 시 임베딩을 만들어 인덱스 저장

매뉴얼 파일 형식:
  title: 문서 제목
  publisher: 발행 기관
  url: https://...
  retrieved_at: 2026-09-17

  ## 문단 제목
  tags: refuge, common
  본문 ...

규칙:
  - 메타는 첫 "## " 헤더 앞에 "키: 값" 으로 적는다 (--- 로 감싸도 된다). title·publisher 는 필수.
  - 문단은 "## " 헤더 단위로 나눈다. "### " 같은 다른 수준의 헤더는 문단 경계로 보지 않는다.
  - 헤더 아래 첫 줄(빈 줄 제외)은 "tags:" 여야 하고, 태그는 exit / refuge / shelter / common / smoke 만 쓴다.
  - 엘리베이터·승강기를 언급하는 문단은 인덱스에 넣지 않는다 (원칙 5).
  - 휴대전화 번호·이메일 등 개인정보로 보이는 내용이 있는 문단은 오류로 처리한다 (원칙 6).
  - 파일 이름이 "_" 로 시작하면(형식 예시 등) 읽지 않는다.
  - 오류가 하나라도 있으면 인덱스를 쓰지 않는다. 내용·태그·출처를 추측해서 채우지 않는다.
"""

import argparse
import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# 검색기와 같은 모델·태그·엘리베이터 판별을 써야 인덱스와 검색이 어긋나지 않는다
from app.services.manual_retriever import (  # noqa: E402
    EMBEDDING_MODEL,
    EXIT_ONLY_PHRASES,
    INDEX_PATH,
    MANUALS_DIR,
    VALID_TAGS,
    is_elevator_paragraph,
)

REQUIRED_META = ("title", "publisher")
OPTIONAL_META = ("url", "retrieved_at")
INDEX_META = ("title", "publisher", "url")  # manual_index.json 에 넣는 메타

META_LINE = re.compile(r"^\s*(title|publisher|url|retrieved_at)\s*:\s*(.*?)\s*$", re.IGNORECASE)
SECTION_HEADER = re.compile(r"^##(?!#)\s+(.+?)\s*$")
DEEPER_HEADER = re.compile(r"^#{3,}\s+\S")
TAGS_LINE = re.compile(r"^\s*tags\s*:\s*(.*?)\s*$", re.IGNORECASE)
PRIVACY_PATTERNS = (
    re.compile(r"01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}"),   # 휴대전화 번호
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),               # 이메일
)
INVISIBLE_CHARS = dict.fromkeys(map(ord, "​‌‍﻿"), None)
REPLACEMENT_CHAR = "�"


@dataclass
class FileReport:
    path: Path
    errors: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    excluded: list = field(default_factory=list)
    sections: list = field(default_factory=list)


# --------------------------------------------------------------------------
# 파싱·검증
# --------------------------------------------------------------------------
def parse_manual(path: Path) -> FileReport:
    report = FileReport(path)
    try:
        raw = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        report.errors.append("UTF-8 로 읽을 수 없습니다. UTF-8 로 저장해 주세요.")
        return report

    broken = raw.count(REPLACEMENT_CHAR)
    if broken:
        report.warnings.append(f"깨진 문자(�) {broken}개 — 원문을 옮기는 과정에서 기호가 손실됐을 수 있습니다.")

    lines = raw.translate(INVISIBLE_CHARS).splitlines()
    header_rows = [i for i, line in enumerate(lines) if SECTION_HEADER.match(line)]
    first_header = header_rows[0] if header_rows else len(lines)

    # 메타 (첫 "## " 헤더 앞)
    meta, stray = {}, 0
    for line in lines[:first_header]:
        stripped = line.strip()
        if not stripped or stripped == "---":
            continue
        match = META_LINE.match(stripped)
        if match:
            meta[match.group(1).lower()] = match.group(2)
        else:
            stray += 1
    for key in REQUIRED_META:
        if not meta.get(key):
            report.errors.append(f"메타 '{key}:' 가 없습니다 (첫 '## ' 헤더 앞에 적어야 합니다).")
    for key in OPTIONAL_META:
        if key not in meta:
            report.warnings.append(f"메타 '{key}:' 가 없습니다.")

    if not header_rows:
        deeper = sum(1 for line in lines if DEEPER_HEADER.match(line))
        hint = f" '### ' 등 다른 수준 헤더 {deeper}개는 문단으로 인식하지 않으니 '## ' 로 바꿔야 합니다." if deeper else ""
        report.errors.append(f"'## ' 문단 헤더가 없습니다.{hint}")
        return report
    if stray:
        report.warnings.append(f"첫 '## ' 헤더 앞의 메타가 아닌 내용 {stray}줄은 인덱스에 넣지 않습니다.")

    # 문단
    bounds = header_rows + [len(lines)]
    for n, (start, end) in enumerate(zip(bounds, bounds[1:]), start=1):
        heading = SECTION_HEADER.match(lines[start]).group(1)
        where = f"{start + 1}행 '## {heading}'"
        body_lines = lines[start + 1:end]

        tag_row = next((i for i, line in enumerate(body_lines) if line.strip()), None)
        if tag_row is None:
            report.errors.append(f"{where}: 본문이 없습니다.")
            continue
        tags_match = TAGS_LINE.match(body_lines[tag_row])
        if not tags_match:
            report.errors.append(f"{where}: 헤더 아래 첫 줄이 'tags:' 가 아닙니다.")
            continue

        tags = list(dict.fromkeys(t.strip().lower() for t in tags_match.group(1).split(",") if t.strip()))
        invalid = [t for t in tags if t not in VALID_TAGS]
        if not tags or invalid:
            shown = ", ".join(invalid) if invalid else "(비어 있음)"
            report.errors.append(
                f"{where}: 사용할 수 없는 태그 {shown} — 허용: {', '.join(sorted(VALID_TAGS))}"
            )
            continue

        body = "\n".join(line.rstrip() for line in body_lines[tag_row + 1:]).strip()
        if not body:
            report.errors.append(f"{where}: tags 아래 본문이 없습니다.")
            continue
        text = f"{heading}\n{body}"

        if any(pattern.search(text) for pattern in PRIVACY_PATTERNS):
            report.errors.append(f"{where}: 개인정보로 보이는 내용(전화번호·이메일)이 있습니다.")
            continue
        if is_elevator_paragraph(text):
            report.excluded.append(f"{where}: 엘리베이터·승강기 언급 → 인덱스에서 제외")
            continue
        if "exit" not in tags:
            phrase = next((p for p in EXIT_ONLY_PHRASES if p in text), None)
            if phrase:
                report.warnings.append(
                    f"{where}: exit 태그가 없는데 '{phrase}' 문구가 있습니다. "
                    "대피공간·제자리 대기 경로에서는 검색되지 않으니 태그를 확인하세요."
                )

        report.sections.append({
            "id": f"{path.stem}#{n:02d}",
            "text": text,
            "tags": tags,
            **{key: meta.get(key, "") for key in INDEX_META},
        })
    return report


def print_report(report: FileReport) -> None:
    status = "오류" if report.errors else "통과"
    print(f"\n[{status}] {report.path.name} — 문단 {len(report.sections)}개, 제외 {len(report.excluded)}개")
    for message in report.errors:
        print(f"  ✗ {message}")
    for message in report.excluded:
        print(f"  - {message}")
    for message in report.warnings:
        print(f"  ! {message}")


# --------------------------------------------------------------------------
# 임베딩·저장
# --------------------------------------------------------------------------
def embed_texts(texts: list) -> list:
    from langchain_openai import OpenAIEmbeddings

    embedder = OpenAIEmbeddings(
        model=EMBEDDING_MODEL,
        timeout=60,
        max_retries=2,
        check_embedding_ctx_length=False,
    )
    return embedder.embed_documents(texts)


def write_index(entries: list, out: Path) -> None:
    """같은 폴더의 임시 파일에 쓴 뒤 교체한다 (중간에 실패해도 기존 인덱스가 깨지지 않게)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".manual_index.", suffix=".json", dir=out.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(entries, f, ensure_ascii=False)
        os.replace(tmp, out)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def _load_dotenv() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv(BACKEND_DIR / ".env")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="매뉴얼 인덱스(manual_index.json) 생성 — 로컬 전용")
    parser.add_argument("--check", action="store_true", help="형식 검사만 하고 임베딩·저장은 하지 않음")
    parser.add_argument("--manuals", type=Path, default=MANUALS_DIR, help="매뉴얼 폴더")
    parser.add_argument("--out", type=Path, default=INDEX_PATH, help="인덱스 파일 경로")
    args = parser.parse_args(argv)

    files = sorted(p for p in args.manuals.glob("*.md") if not p.name.startswith("_")) if args.manuals.is_dir() else []
    if not files:
        print(f"매뉴얼 파일이 없습니다: {args.manuals}")
        return 1

    reports = [parse_manual(path) for path in files]
    for report in reports:
        print_report(report)

    error_count = sum(len(r.errors) for r in reports)
    sections = [s for r in reports for s in r.sections]
    print(f"\n합계: 파일 {len(files)}개, 문단 {len(sections)}개, 오류 {error_count}개, "
          f"제외 {sum(len(r.excluded) for r in reports)}개, 경고 {sum(len(r.warnings) for r in reports)}개")

    if error_count:
        print("오류가 있어 인덱스를 만들지 않았습니다. 원문 파일을 형식에 맞게 고친 뒤 다시 실행하세요.")
        return 1
    if not sections:
        print("인덱스에 넣을 문단이 없습니다.")
        return 1
    if args.check:
        print("형식 검사 통과 (--check: 임베딩·저장 생략)")
        return 0

    _load_dotenv()
    if not os.getenv("OPENAI_API_KEY"):
        print("OPENAI_API_KEY 가 없어 임베딩을 만들 수 없습니다. "
              "backend/.env 또는 환경변수에 키를 설정한 뒤 다시 실행하세요. (형식 검사만 하려면 --check)")
        return 2

    try:
        vectors = embed_texts([s["text"] for s in sections])
    except Exception as exc:  # noqa: BLE001
        print(f"임베딩 생성 실패: {type(exc).__name__}: {exc}")
        return 1
    if len(vectors) != len(sections) or not all(vectors):
        print("임베딩 결과 개수가 문단 수와 맞지 않습니다. 인덱스를 쓰지 않았습니다.")
        return 1

    entries = [
        {
            "id": s["id"],
            "text": s["text"],
            "tags": s["tags"],
            "title": s["title"],
            "publisher": s["publisher"],
            "url": s["url"],
            "embedding": [float(x) for x in vector],
        }
        for s, vector in zip(sections, vectors)
    ]
    write_index(entries, args.out)
    print(f"저장: {args.out} (문단 {len(entries)}개, 모델 {EMBEDDING_MODEL}, "
          f"{len(entries[0]['embedding'])}차원, {args.out.stat().st_size / 1024:.0f}KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
