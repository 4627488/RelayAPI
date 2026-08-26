import { describe, expect, it, vi } from "vitest"
import { render } from "vitest-browser-react"

import { useAsyncResource } from "@/hooks/use-async-resource"

function ResourceHarness({ loader }: { loader: () => Promise<string> }) {
  const { data, error, loading, reload } = useAsyncResource(loader, {
    initialData: "",
    errorMessage: "读取失败",
  })

  if (loading) return <p>加载中</p>
  if (error) {
    return (
      <div>
        <p role="alert">{error}</p>
        <button type="button" onClick={() => void reload(true)}>
          重试
        </button>
      </div>
    )
  }
  return <p>{data}</p>
}

describe("async resource", () => {
  it("provides a consistent retryable error state", async () => {
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("网络不可用"))
      .mockResolvedValueOnce("数据已恢复")
    const screen = await render(<ResourceHarness loader={loader} />)

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("网络不可用")
    await screen.getByRole("button", { name: "重试" }).click()
    await expect.element(screen.getByText("数据已恢复")).toBeInTheDocument()
    expect(loader).toHaveBeenCalledTimes(2)
  })
})
