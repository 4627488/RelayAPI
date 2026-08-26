import {
  Layout,
  LayoutContent,
  LayoutHeader,
  VStack,
} from "@astryxdesign/core/Layout"
import { Skeleton } from "@astryxdesign/core/Skeleton"

export function LoadingView() {
  return (
    <Layout
      height="fill"
      defaultHasDividers
      header={
        <LayoutHeader>
          <Skeleton height={28} width={160} />
        </LayoutHeader>
      }
    >
      <LayoutContent padding={0}>
        <VStack gap={0}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </VStack>
      </LayoutContent>
    </Layout>
  )
}
