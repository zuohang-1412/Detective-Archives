# 微信公众号 DOCX 生成工具

这组脚本从仓库里的 Markdown 源稿和 PNG 配图生成可导入微信公众号后台的 Word 文档。路径均以仓库根目录为基准，不依赖作者电脑上的用户名或绝对路径。

## 已支持的文章

- `content/wechat/launch-01/01-opening.md`
- `content/wechat/launch-01/02-sherlock-holmes.md`
- `content/wechat/sherlock-holmes/001-gloria-scott.md`

每篇文章使用的最终图片及 AI 生成提示词都保存在对应的 `assets` 目录中。Word 文件是可重建产物，不需要从一台电脑复制到另一台电脑。

提示词记录：

- `content/wechat/launch-01/assets/01-opening/generation-record.md`
- `content/wechat/launch-01/assets/02-sherlock-holmes/generation-record.md`
- `content/wechat/sherlock-holmes/assets/001-gloria-scott/generation-record.md`

## 环境要求

- Windows、macOS 或 Linux
- Python 3.10 或更高版本
- 约 100 MB 可用空间

安装依赖：

```bash
python -m pip install -r tools/requirements-wechat-docx.txt
```

如果电脑上的 Python 命令名是 `python3`，把以上命令及下文的 `python` 换成 `python3`。

## 一次生成全部文章

从仓库根目录执行：

```bash
python tools/build_all_wechat_docx.py
```

默认输出到 `content/wechat/publish/`。脚本会同时检查 DOCX 压缩包完整性和内嵌图片数量。

也可以指定输出目录：

```bash
python tools/build_all_wechat_docx.py --output-dir output/wechat
```

## 单篇生成

```bash
python tools/build_opening_wechat_docx.py
python tools/build_sherlock_wechat_docx.py
python tools/build_gloria_scott_wechat_docx.py
```

每个单篇脚本都支持 `--output` 指定文件名：

```bash
python tools/build_gloria_scott_wechat_docx.py --output output/gloria-scott.docx
```

## 字体兼容

默认字体为 `Microsoft YaHei`。Word、WPS 或 LibreOffice 会在缺少该字体时执行字体替换。若希望明确指定本机字体，可设置环境变量：

Windows PowerShell：

```powershell
$env:WECHAT_DOCX_FONT = "Noto Sans CJK SC"
python tools/build_all_wechat_docx.py
```

macOS / Linux：

```bash
WECHAT_DOCX_FONT="Noto Sans CJK SC" python tools/build_all_wechat_docx.py
```

## 新增文章时的约定

1. Markdown 开头保留 `title`、`summary`、`coverImage` 和 `projectMark` 字段。
2. 图片路径相对于 Markdown 文件填写。
3. 将最终 PNG 与完整提示词记录一起放入文章的 `assets` 目录。
4. 新建一个轻量入口脚本，向 `wechat_docx_builder.py` 提供标题眉、封面替代文字、元数据行和输出文件名。
5. 将入口加入 `build_all_wechat_docx.py` 后重新执行全量构建。

生成完成后，仍建议在微信公众号后台查看一次手机预览，确认平台导入后的封面裁切、图片间距与链接样式。
