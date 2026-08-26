package rai

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
)

func (a *App) update(ctx context.Context) error {
	releasesURL := a.Releases
	if releasesURL == "" {
		releasesURL = strings.TrimSpace(os.Getenv(envReleasesURL))
	}
	release, err := a.Gateway.LatestRelease(ctx, releasesURL)
	if err != nil {
		return err
	}
	fmt.Fprintf(a.Stdout, "installed: %s\n", Version)
	fmt.Fprintf(a.Stdout, "latest:    %s\n", release.Tag)
	if release.Tag == "" || release.Tag == Version || release.Tag == "v"+Version {
		fmt.Fprintln(a.Stdout, "rai is up to date")
		return nil
	}
	asset, ok := selectReleaseAsset(release.Assets, runtime.GOOS, runtime.GOARCH)
	if !ok {
		fmt.Fprintf(a.Stdout, "No published rai binary for %s/%s.\n", runtime.GOOS, runtime.GOARCH)
		fmt.Fprintln(a.Stdout, "Install from source:")
		fmt.Fprintln(a.Stdout, "  go install github.com/4627488/RelayAPI/cmd/rai@latest")
		return nil
	}
	target := a.Self
	if target == "" || target == "rai" {
		target, err = lookPath("rai")
		if err != nil {
			return err
		}
	}
	fmt.Fprintf(a.Stdout, "downloading %s\n", asset.Name)
	if err := replaceExecutable(ctx, a.Gateway.HTTP, asset.URL, target); err != nil {
		return err
	}
	fmt.Fprintf(a.Stdout, "updated %s to %s\n", target, release.Tag)
	return nil
}

func selectReleaseAsset(assets []ReleaseAsset, goos, goarch string) (ReleaseAsset, bool) {
	needles := []string{
		"rai-" + goos + "-" + goarch,
		"rai_" + goos + "_" + goarch,
		"rai-" + goos + "_" + goarch,
	}
	if goos == "windows" {
		for i := range needles {
			needles[i] += ".exe"
		}
	}
	for _, asset := range assets {
		name := strings.ToLower(asset.Name)
		for _, needle := range needles {
			if strings.Contains(name, needle) {
				return asset, true
			}
		}
	}
	return ReleaseAsset{}, false
}

func replaceExecutable(ctx context.Context, client *http.Client, rawURL, target string) error {
	if client == nil {
		client = http.DefaultClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "rai/"+Version)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s", resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return fmt.Errorf("downloaded empty binary")
	}
	return writeFileAtomic(target, data, 0o755)
}
