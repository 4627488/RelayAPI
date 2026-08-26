package rai

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"
)

func (a *App) update(ctx context.Context) error {
	server, err := a.updateServer()
	if err != nil {
		return err
	}
	discovery, err := a.Gateway.Discover(ctx, server)
	if err != nil {
		return err
	}
	latest := strings.TrimSpace(discovery.RAIVersion)
	fmt.Fprintf(a.Stdout, "installed: %s\n", Version)
	if latest != "" {
		fmt.Fprintf(a.Stdout, "site:      %s\n", latest)
		if latest == Version || latest == "v"+Version {
			fmt.Fprintln(a.Stdout, "rai matches this site")
			return nil
		}
	}
	rawURL := raiDownloadURL(server, discovery.Download, runtime.GOOS, runtime.GOARCH)
	target := a.Self
	if target == "" || target == "rai" {
		target, err = lookPath("rai")
		if err != nil {
			return err
		}
	}
	fmt.Fprintf(a.Stdout, "downloading %s\n", rawURL)
	if err := replaceExecutable(ctx, a.Gateway.HTTP, rawURL, target); err != nil {
		return err
	}
	if latest == "" {
		latest = "site build"
	}
	fmt.Fprintf(a.Stdout, "updated %s to %s\n", target, latest)
	return nil
}

func (a *App) updateServer() (string, error) {
	if server := strings.TrimSpace(os.Getenv(envServer)); server != "" {
		return normalizeServerURL(server)
	}
	store, err := a.store()
	if err != nil {
		return "", err
	}
	profile, err := store.ResolveProfile("")
	if err != nil {
		return "", errors.New("rai update needs a logged-in profile or RAI_SERVER")
	}
	return normalizeServerURL(profile.ServerURL)
}

func raiDownloadURL(server, download, goos, goarch string) string {
	download = strings.TrimSpace(download)
	if download == "" {
		download = "/rai/download"
	}
	target := goos + "-" + goarch
	if strings.HasPrefix(download, "http://") || strings.HasPrefix(download, "https://") {
		return strings.TrimRight(download, "/") + "/" + target
	}
	return strings.TrimRight(server, "/") + "/" + strings.Trim(download, "/") + "/" + target
}

func replaceExecutable(ctx context.Context, client *http.Client, rawURL, target string) error {
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute}
	} else {
		clone := *client
		if clone.Timeout < 2*time.Minute {
			clone.Timeout = 2 * time.Minute
		}
		client = &clone
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
