from __future__ import annotations

import argparse
from pathlib import Path

from wechat_docx_builder import ArticleConfig, ROOT, build_article


SOURCE = ROOT / "content" / "wechat" / "launch-01" / "01-opening.md"
DEFAULT_OUTPUT = (
    ROOT
    / "content"
    / "wechat"
    / "launch-01"
    / "publish"
    / "侦探档案馆开馆说明-公众号导入版.docx"
)


def build(output: Path = DEFAULT_OUTPUT):
    return build_article(
        ArticleConfig(
            source=SOURCE,
            output=output,
            eyebrow="侦探档案馆  ·  OPENING NOTE",
            cover_alt="深蓝档案柜、黄铜编号牌、摊开的案件卡与一束温暖灯光",
            subject="微信公众号导入版：侦探档案馆开馆说明",
            keywords="侦探档案馆, 开馆说明, 侦探小说, 时间线, 无剧透",
            meta_line="开馆说明  ·  预计阅读 {estimatedReadMinutes} 分钟",
        )
    )


def main():
    parser = argparse.ArgumentParser(description="生成《侦探档案馆开馆说明》公众号导入版 DOCX")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    print(build(args.output.resolve()))


if __name__ == "__main__":
    main()
