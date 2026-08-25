import { Grid } from "@astryxdesign/core/Grid"
import { VStack } from "@astryxdesign/core/Layout"
import { Skeleton } from "@astryxdesign/core/Skeleton"

export function LoadingView() {
  return (
    <VStack gap={4} padding={4}>
      <Grid columns={{ minWidth: 180, max: 4 }} gap={3}>
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} height={96} />
        ))}
      </Grid>
      <Skeleton height={320} />
    </VStack>
  )
}
