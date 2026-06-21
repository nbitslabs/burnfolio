package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/nbitslabs/burnfolio/internal/usage"
)

func main() {
	var (
		home       string
		providers  string
		jsonOutput bool
		profile    string
		machine    string
		server     string
	)

	defaultHome, err := os.UserHomeDir()
	if err != nil {
		defaultHome = ""
	}

	flag.StringVar(&home, "home", defaultHome, "home directory containing agent data")
	flag.StringVar(&providers, "providers", "claude,codex,opencode,pi", "comma-separated providers to scan")
	flag.BoolVar(&jsonOutput, "json", false, "print JSON instead of a table")
	flag.StringVar(&profile, "profile", "", "Burnfolio account number or username to sync to")
	flag.StringVar(&machine, "machine", "", "Burnfolio machine token for sync")
	flag.StringVar(&server, "server", defaultServer(), "Burnfolio server URL")
	flag.Parse()

	if home == "" {
		fmt.Fprintln(os.Stderr, "could not determine home directory; pass -home")
		os.Exit(2)
	}

	selected := usage.ParseProviderList(providers)
	report, err := usage.Collect(context.Background(), usage.Options{
		HomeDir:    home,
		Providers:  selected,
		MaxErrors:  20,
		IncludeRaw: false,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	if jsonOutput {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(report); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	fmt.Print(usage.FormatReport(report))

	if profile != "" || machine != "" {
		if profile == "" || machine == "" {
			fmt.Fprintln(os.Stderr, "sync requires both -profile and -machine")
			os.Exit(2)
		}
		result, err := syncReport(context.Background(), server, profile, machine, report)
		if err != nil {
			fmt.Fprintf(os.Stderr, "sync failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("\nSynced %d UTC days to %s for %s.\n", result.UpsertedDays, strings.TrimRight(server, "/"), profile)
	}

	if len(report.Warnings) > 0 {
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "Warnings:")
		for _, warning := range report.Warnings {
			fmt.Fprintf(os.Stderr, "- %s\n", strings.TrimSpace(warning))
		}
	}
}

type syncPayload struct {
	Profile string          `json:"profile"`
	Days    []usage.SyncDay `json:"days"`
}

type syncResult struct {
	OK           bool   `json:"ok"`
	UpsertedDays int    `json:"upserted_days"`
	Error        string `json:"error"`
}

func syncReport(ctx context.Context, server string, profile string, machineToken string, report usage.Report) (syncResult, error) {
	payload := syncPayload{
		Profile: profile,
		Days:    usage.DailyTotals(report),
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return syncResult{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	endpoint := strings.TrimRight(server, "/") + "/api/ingest"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return syncResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+machineToken)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return syncResult{}, err
	}
	defer res.Body.Close()

	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return syncResult{}, err
	}
	var result syncResult
	if err := json.Unmarshal(body, &result); err != nil {
		return syncResult{}, fmt.Errorf("unexpected response from %s: %s", endpoint, strings.TrimSpace(string(body)))
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		if result.Error == "" {
			result.Error = res.Status
		}
		return result, fmt.Errorf("%s", result.Error)
	}
	return result, nil
}

func defaultServer() string {
	if value := strings.TrimSpace(os.Getenv("BURNFOLIO_SERVER")); value != "" {
		return value
	}
	return "https://burnfolio.ai"
}
