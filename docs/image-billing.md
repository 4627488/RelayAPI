# 生图模型计费设计

## 计费口径

业界主要有两种口径：Google Imagen 等模型按成功产出的图片张数计费；GPT Image、
Gemini 原生生图按实际模态 token 计费。RelayAPI 按模型选择权威计量口径；本次生产
接入优先使用上游返回的精确用量：

1. 上游返回文本/图片 token 明细时，分别按文本输入、缓存文本输入、图片输入、缓存
   图片输入、文本输出、图片输出和推理费率结算。
2. 后续接入只有按张报价且不返回 token 的模型时，应配置固定图片单价，并按成功
   产物数结算；尺寸或质量差价应作为独立 SKU 或受控倍率，不能按响应文件字节数推算。
3. 上游失败不收费；成功但缺少用量时保留预授权并标记 `pricing_complete=false`，等待
   对账，不把未知成本当作免费。
4. 每次请求保存模型、费率版本、倍率和完整费率快照，后续调价不改写历史账单。

当前接入的 GPT Image 2 会返回 `input_tokens_details.image_tokens`、
`input_tokens_details.text_tokens` 和图片输出 token，因此使用精确 token 结算。质量、尺寸
和图片数量已经体现在实际图片输出 token 中，不再维护易失真的“每张估算价”矩阵。

## 生产价格

GPT Image 2 使用 OpenAI Standard 官方费率，币种为 USD：

| 计量项 | USD / 1M token | nano-USD / token |
| --- | ---: | ---: |
| 文本输入 | 5.00 | 5,000 |
| 缓存文本输入 | 1.25 | 1,250 |
| 图片输入 | 8.00 | 8,000 |
| 缓存图片输入 | 2.00 | 2,000 |
| 图片输出 | 30.00 | 30,000 |

文本输出、缓存写入和推理费率为 0，因为 GPT Image 2 的直接 Images API 不产生这些
计量项。价格版本为 `openai-standard-2026-08-10`，整体倍率为 `1`，即按上游成本价
结算；如需渠道毛利，应通过现有价格倍率显式配置，不能修改原始用量。

成本公式为：

```text
cost = uncached_text_input × text_input_rate
     + cached_text_input × cached_text_input_rate
     + uncached_image_input × image_input_rate
     + cached_image_input × cached_image_input_rate
     + image_output × image_output_rate
     + other_text_output/cache_write/reasoning charges
```

生产环境对图片模型按请求中的 `n` 逐张预授权 500,000,000 nano-USD（$0.50），实际
响应后多退少补。该额度高于官方示例中的高质量常用尺寸输出成本，并给编辑请求的图片
输入留出空间。可用 `BILLING_IMAGE_RESERVE_NANO_USD` 调整，但不应低于典型单张最高
成本。

官方依据：

- [OpenAI API Pricing](https://developers.openai.com/api/docs/pricing)
- [OpenAI Image generation：成本和输出 token](https://developers.openai.com/api/docs/guides/image-generation#cost-and-latency)
- [OpenAI Images API usage 字段](https://developers.openai.com/api/reference/resources/images)
- [Gemini API Pricing](https://ai.google.dev/gemini-api/docs/pricing)
