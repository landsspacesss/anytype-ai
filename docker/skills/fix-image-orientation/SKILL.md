---
name: fix-image-orientation
description: Use when images on an Anytype page look sideways or rotated (e.g. phone photos lying on their side) while the same file looks upright elsewhere — usually a JPEG EXIF Orientation tag that Anytype ignores.
---

# 修正图片方向（EXIF 横躺）

## 是什么

手机拍的照片常常**像素本身没转**，只带一个 EXIF `Orientation` 标记。会读 EXIF
的软件把它摆正显示；不读的（**Anytype 就不读**）就横躺着。

修法 = 把旋转**烤进像素**并**抹掉 EXIF** → 重新上传 → 把页面里的图块**指到新文件**。

**Anytype 没有"原地旋转/替换"接口**，只能换对象。

## 前置

需要一个能跑 shell 的会话（普通空间、`auto`/`ask` 模式都行）。**控制台/`readonly` 没有
bash，做不了。** 需要 `sharp`（容器内已装）。

## 速查

| 步骤 | 怎么做 |
|---|---|
| 找页面里的图 | `anytype_read_object {id: 页面id}` → 图块行形如 `![IMG_4136.jpeg](图对象id) [block:块id]` |
| 下载原图 | `anytype_download_images {id: 页面id}` → 路径在 `/workspace/<space>/images/<id>/` |
| 看方向 | `bash`：`node -e "require('sharp')('<file>').metadata().then(m=>console.log(m.width,m.height,m.orientation))"`，**orientation 5–8 = 需旋转**，`undefined`/`1` = 本来就正 |
| 摆正 + 抹 EXIF | `bash`：`node -e "require('sharp')('<in>').rotate().jpeg({quality:92}).toFile('<out>')"` |
| 上传新图 | `anytype_upload_file {path:"<out>", name:"<名字>"}` → 返回新对象 id |
| 换图块指向 | `anytype_update_block {id: 页面id, block_id:"<块id>", set:{"object_id":"<新图id>"}}` |
| 旧图 | **先别删**；确认无误后由用户决定 |

`.rotate()` **不带参数** = 按 EXIF 自动摆正 **且丢弃元数据**（到哪都正）。

## 步骤

1. `anytype_read_object {id:页面}` —— 按行拿到每张图的 `(名字, 图对象id, 块id)`（形如
   `![IMG_4136.jpeg](bafyrei…) [block:b4791]`）。同时 `anytype_download_images {id:页面}` 把原图下到本地。
2. 对每张图 **先诊断**（`sharp metadata()` 看 orientation），列出哪些是 5–8（按名字对上）。
3. 对需要的图，用 `sharp().rotate()` 输出到新文件（**别覆盖原图**）。
4. 逐张 `anytype_upload_file {path}`，记下"原图对象id → 新图对象id"。
5. `anytype_update_block {id:页面, block_id:"<块id>", set:{"object_id":"<新图id>"}}` 逐块换指向
   （块 id 来自第 1 步；**别用 `match`**，图块没文本，匹配不到）。
6. 换完 `anytype_read_object` 复查；把结果（换了哪些、旧对象 id 列表）报告给用户。

## 注意 / 坑

- **改块前先备份**：把原 `object_id` 列表记下来；换错了可以再换回去。
- 一张图可能**嵌在多个页面**——`object_id` 换一处不影响别处；按需逐个换。
- `update_block` 的 `match` 靠**文本**，图块没文本 → **必须用 `block_id`**。
- 批量：先全部上传拿到新 id，再统一换块，减少往返。
- 删除对象**不可恢复**；默认保留旧图。
- 只处理 orientation 5–8 的；1/undefined 的跳过（本来就正）。

## 常见错误

| 错 | 对 |
|---|---|
| 用 `match` 定位图块 | 用 `block_id` |
| 直接改原图的 EXIF | Anytype 不看 EXIF——必须烤进像素重传 |
| 覆盖原文件后上传 | 另存新文件，保留原图做备份 |
| 顺手删旧图 | 先留，等用户确认 |
