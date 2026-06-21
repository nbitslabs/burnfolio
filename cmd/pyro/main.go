package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/nbitslabs/burnfolio/internal/usage"
)

func main() {
	var (
		home       string
		providers  string
		jsonOutput bool
	)

	defaultHome, err := os.UserHomeDir()
	if err != nil {
		defaultHome = ""
	}

	flag.StringVar(&home, "home", defaultHome, "home directory containing agent data")
	flag.StringVar(&providers, "providers", "claude,codex,opencode,pi", "comma-separated providers to scan")
	flag.BoolVar(&jsonOutput, "json", false, "print JSON instead of a table")
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

	if len(report.Warnings) > 0 {
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "Warnings:")
		for _, warning := range report.Warnings {
			fmt.Fprintf(os.Stderr, "- %s\n", strings.TrimSpace(warning))
		}
	}
}
