from __future__ import annotations

import argparse
from pathlib import Path

from wechat_docx_builder import ArticleConfig, ROOT, build_article


SOURCE = ROOT / "content" / "wechat" / "sherlock-holmes" / "001-gloria-scott.md"
DEFAULT_OUTPUT = (
    ROOT
    / "content"
    / "wechat"
    / "sherlock-holmes"
    / "publish"
    / "福尔摩斯档案001-格洛里亚·斯科特号-公众号导入版.docx"
)


def build(output: Path = DEFAULT_OUTPUT):
    return build_article(
        ArticleConfig(
            source=SOURCE,
            output=output,
            eyebrow="福尔摩斯案件档案 001  ·  THE GLORIA SCOTT",
            cover_alt="青年福尔摩斯在诺福克老宅展示观察方法，维克多与父亲在旁，远处帆船暗示旧日航海往事",
            subject="微信公众号导入版：福尔摩斯案件档案001，无核心剧透导读",
            keywords="福尔摩斯, 格洛里亚·斯科特号, Sherlock Holmes, Gloria Scott, 无剧透",
            meta_line="档案 SH-001-GLOR  ·  {spoilerLevel}  ·  预计阅读 {estimatedReadMinutes} 分钟",
            metadata_pattern=r"^\*\*(档案编号|原名|人物阶段|时间线位置|故事时间|首次发表|收录)：",
        )
    )


def main():
    parser = argparse.ArgumentParser(description="生成《格洛里亚·斯科特号》公众号导入版 DOCX")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    print(build(args.output.resolve()))


if __name__ == "__main__":
    main()
