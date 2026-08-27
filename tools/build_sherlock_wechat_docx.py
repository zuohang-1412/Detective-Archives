from __future__ import annotations

import argparse
from pathlib import Path

from wechat_docx_builder import ArticleConfig, ROOT, build_article


SOURCE = ROOT / "content" / "wechat" / "launch-01" / "02-sherlock-holmes.md"
DEFAULT_OUTPUT = (
    ROOT
    / "content"
    / "wechat"
    / "launch-01"
    / "publish"
    / "夏洛克·福尔摩斯人物总档案-公众号导入版.docx"
)


def build(output: Path = DEFAULT_OUTPUT):
    return build_article(
        ArticleConfig(
            source=SOURCE,
            output=output,
            eyebrow="人物总档案 001  ·  SHERLOCK HOLMES",
            cover_alt="十九世纪版画风格的福尔摩斯在贝克街检验线索，身旁摆放提琴、地图和化学器材",
            subject="微信公众号导入版：人物简介与60桩正典案件时间线",
            keywords="夏洛克·福尔摩斯, Sherlock Holmes, 侦探档案, 时间线, 无剧透",
            meta_line="档案编号 DA-001  ·  4部长篇＋56篇短篇  ·  预计阅读 {estimatedReadMinutes} 分钟",
            case_heading_pattern=r"^\d{3}｜",
            metadata_pattern=r"^\*\*(档案编号|本期范围|整理方式)：",
            highlight_pattern=r"^\*\*观察点：",
        )
    )


def build_document(output: Path = DEFAULT_OUTPUT):
    """Backward-compatible entry point used by earlier local commands."""
    return build(output)


def main():
    parser = argparse.ArgumentParser(description="生成《夏洛克·福尔摩斯人物总档案》公众号导入版 DOCX")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    print(build(args.output.resolve()))


if __name__ == "__main__":
    main()
