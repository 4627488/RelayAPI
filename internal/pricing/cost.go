package pricing

import (
	"github.com/4627488/RelayAPI/internal/metering"
	"math"
)

type Usage = metering.Usage

// CostNanoUSD prices disjoint input/cache buckets. Reasoning is included in
// output, exactly as Magpie CostSplit; it is never billed a second time.
func CostNanoUSD(price SnapshotPrice, usage Usage) int64 {
	price.Price = price.Price.At(usage.Prompt())
	cachedImage := min64(max64(0, usage.CachedImageInput), min64(max64(0, usage.ImageInput), max64(0, usage.CacheRead)))
	imageInput := min64(max64(0, usage.ImageInput-cachedImage), max64(0, usage.Input))
	imageOutput := min64(max64(0, usage.ImageOutput), max64(0, usage.Output))
	hour := min64(max64(0, usage.CacheWrite1h), max64(0, usage.CacheWrite))
	hourRate := price.CacheWrite1hNanoUSDPerToken
	if hourRate == 0 {
		hourRate = price.CacheWriteNanoUSDPerToken
	}
	result := int64(0)
	for _, item := range [][2]int64{
		{max64(0, usage.Input-imageInput), price.InputNanoUSDPerToken},
		{max64(0, usage.CacheRead-cachedImage), price.CachedInputNanoUSDPerToken},
		{imageInput, price.ImageInputNanoUSDPerToken},
		{cachedImage, price.CachedImageInputNanoUSDPerToken},
		{max64(0, usage.Output-imageOutput), price.OutputNanoUSDPerToken},
		{imageOutput, price.ImageOutputNanoUSDPerToken},
		{max64(0, usage.CacheWrite-hour), price.CacheWriteNanoUSDPerToken},
		{hour, hourRate},
	} {
		result = saturatingAdd(result, saturatingMultiply(item[0], item[1]))
	}
	return result
}

func saturatingMultiply(left, right int64) int64 {
	if left <= 0 || right <= 0 {
		return 0
	}
	if left > math.MaxInt64/right {
		return math.MaxInt64
	}
	return left * right
}

func saturatingAdd(left, right int64) int64 {
	if left >= math.MaxInt64-right {
		return math.MaxInt64
	}
	return left + right
}

func max64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

func min64(left, right int64) int64 {
	if left < right {
		return left
	}
	return right
}
