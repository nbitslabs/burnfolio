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
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/nbitslabs/burnfolio/internal/usage"
)

var version = "dev"

type config struct {
	Profile         string `json:"profile,omitempty"`
	Machine         string `json:"machine,omitempty"`
	Server          string `json:"server,omitempty"`
	Providers       string `json:"providers,omitempty"`
	InstallDir      string `json:"install_dir,omitempty"`
	Installed       bool   `json:"installed"`
	UninstalledAt   string `json:"uninstalled_at,omitempty"`
	LastSyncAt      string `json:"last_sync_at,omitempty"`
	LastSyncStatus  string `json:"last_sync_status,omitempty"`
	LastPyroVersion string `json:"last_pyro_version,omitempty"`
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "status":
			if err := statusCmd(os.Args[2:]); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		case "install":
			if err := installCmd(os.Args[2:]); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		case "uninstall":
			if err := uninstallCmd(os.Args[2:]); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		case "sync":
			os.Args = append([]string{os.Args[0]}, os.Args[2:]...)
		case "version":
			fmt.Println(version)
			return
		}
	}

	var (
		home       string
		providers  string
		jsonOutput bool
		profile    string
		machine    string
		server     string
		noSync     bool
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
	flag.BoolVar(&noSync, "no-sync", false, "collect and print only; do not sync even when configured")
	flag.BoolVar(&noSync, "no-run", false, "alias for -no-sync")
	flag.Parse()

	if home == "" {
		fmt.Fprintln(os.Stderr, "could not determine home directory; pass -home")
		os.Exit(2)
	}

	cfg, _ := loadConfig(defaultHome)
	if providers == "claude,codex,opencode,pi" && cfg.Providers != "" {
		providers = cfg.Providers
	}
	if profile == "" && cfg.Installed {
		profile = cfg.Profile
	}
	if machine == "" && cfg.Installed {
		machine = cfg.Machine
	}
	if server == defaultServer() && cfg.Server != "" {
		server = cfg.Server
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

	if !noSync && (profile != "" || machine != "") {
		if profile == "" || machine == "" {
			fmt.Fprintln(os.Stderr, "sync requires both -profile and -machine")
			os.Exit(2)
		}
		result, err := syncReport(context.Background(), server, profile, machine, report)
		if err != nil {
			cfg.LastSyncAt = time.Now().UTC().Format(time.RFC3339)
			cfg.LastSyncStatus = "failed: " + err.Error()
			_ = saveConfig(defaultHome, cfg)
			fmt.Fprintf(os.Stderr, "sync failed: %v\n", err)
			os.Exit(1)
		}
		cfg.Profile = profile
		cfg.Machine = machine
		cfg.Server = server
		cfg.Providers = providers
		cfg.Installed = true
		cfg.UninstalledAt = ""
		cfg.LastSyncAt = time.Now().UTC().Format(time.RFC3339)
		cfg.LastSyncStatus = fmt.Sprintf("ok: %d days", result.UpsertedDays)
		cfg.LastPyroVersion = version
		_ = saveConfig(defaultHome, cfg)
		fmt.Printf("\nSynced %d days to %s for %s.\n", result.UpsertedDays, strings.TrimRight(server, "/"), profile)
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
	Profile     string          `json:"profile"`
	PyroVersion string          `json:"pyro_version"`
	Days        []usage.SyncDay `json:"days"`
}

type syncResult struct {
	OK           bool   `json:"ok"`
	UpsertedDays int    `json:"upserted_days"`
	Error        string `json:"error"`
}

func syncReport(ctx context.Context, server string, profile string, machineToken string, report usage.Report) (syncResult, error) {
	payload := syncPayload{
		Profile:     profile,
		PyroVersion: cleanClientVersion(version),
		Days:        usage.DailyTotals(report),
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

func installCmd(args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	home, _ := os.UserHomeDir()
	cfg, _ := loadConfig(home)
	profile := fs.String("profile", cfg.Profile, "Burnfolio profile")
	machine := fs.String("machine", cfg.Machine, "Burnfolio machine token")
	server := fs.String("server", valueOr(cfg.Server, defaultServer()), "Burnfolio server URL")
	providers := fs.String("providers", valueOr(cfg.Providers, "claude,codex,opencode,pi"), "providers to scan")
	installDir := fs.String("install-dir", cfg.InstallDir, "install directory")
	schedule := fs.String("schedule", "", "recorded schedule")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg.Profile = strings.TrimSpace(*profile)
	cfg.Machine = strings.TrimSpace(*machine)
	cfg.Server = strings.TrimRight(strings.TrimSpace(*server), "/")
	cfg.Providers = strings.TrimSpace(*providers)
	cfg.InstallDir = strings.TrimSpace(*installDir)
	cfg.Installed = true
	cfg.UninstalledAt = ""
	cfg.LastPyroVersion = version
	if *schedule != "" {
		cfg.LastSyncStatus = "installed; schedule=" + strings.TrimSpace(*schedule)
	}
	if err := saveConfig(home, cfg); err != nil {
		return err
	}
	fmt.Printf("Configured pyro at %s\n", configPath(home))
	return nil
}

func uninstallCmd(args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	home, _ := os.UserHomeDir()
	profile := fs.String("profile", "", "profile cron marker to remove")
	keepCron := fs.Bool("keep-cron", false, "leave cron entries installed")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, _ := loadConfig(home)
	if !*keepCron {
		if err := removeCron(strings.TrimSpace(valueOr(*profile, cfg.Profile))); err != nil {
			fmt.Fprintf(os.Stderr, "warning: could not update crontab: %v\n", err)
		}
	}
	cfg.Installed = false
	cfg.UninstalledAt = time.Now().UTC().Format(time.RFC3339)
	cfg.LastSyncStatus = "uninstalled"
	cfg.LastPyroVersion = version
	if err := saveConfig(home, cfg); err != nil {
		return err
	}
	fmt.Printf("Marked pyro uninstalled in %s\n", configPath(home))
	return nil
}

func statusCmd(args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	jsonOutput := fs.Bool("json", false, "print JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	home, _ := os.UserHomeDir()
	cfg, _ := loadConfig(home)
	if *jsonOutput {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(cfg)
	}
	fmt.Printf("pyro %s\n", version)
	fmt.Printf("config: %s\n", configPath(home))
	fmt.Printf("installed: %t\n", cfg.Installed)
	if cfg.UninstalledAt != "" {
		fmt.Printf("uninstalled_at: %s\n", cfg.UninstalledAt)
	}
	fmt.Printf("profile: %s\n", valueOr(cfg.Profile, "(not configured)"))
	fmt.Printf("machine: %s\n", masked(cfg.Machine))
	fmt.Printf("server: %s\n", valueOr(cfg.Server, defaultServer()))
	fmt.Printf("providers: %s\n", valueOr(cfg.Providers, "claude,codex,opencode,pi"))
	if cfg.LastSyncAt != "" {
		fmt.Printf("last_sync: %s %s\n", cfg.LastSyncAt, cfg.LastSyncStatus)
	}
	return nil
}

func loadConfig(home string) (config, error) {
	var cfg config
	path := configPath(home)
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			cfg.Server = defaultServer()
			cfg.Providers = "claude,codex,opencode,pi"
			return cfg, nil
		}
		return cfg, err
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, err
	}
	if cfg.Server == "" {
		cfg.Server = defaultServer()
	}
	if cfg.Providers == "" {
		cfg.Providers = "claude,codex,opencode,pi"
	}
	return cfg, nil
}

func saveConfig(home string, cfg config) error {
	path := configPath(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	return os.WriteFile(path, raw, 0o600)
}

func configPath(home string) string {
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return filepath.Join(home, ".pyro", "config.json")
}

func removeCron(profile string) error {
	if _, err := exec.LookPath("crontab"); err != nil {
		return nil
	}
	out, err := exec.Command("crontab", "-l").Output()
	if err != nil {
		out = nil
	}
	var kept []string
	for _, line := range strings.Split(string(out), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if profile != "" && strings.Contains(line, "# burnfolio-pyro "+profile) {
			continue
		}
		if profile == "" && strings.Contains(line, "# burnfolio-pyro ") {
			continue
		}
		kept = append(kept, line)
	}
	cmd := exec.Command("crontab", "-")
	cmd.Stdin = strings.NewReader(strings.Join(kept, "\n") + "\n")
	return cmd.Run()
}

func cleanClientVersion(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 40 {
		return "dev"
	}
	for _, r := range value {
		if !(r == 'v' || r == '.' || r == '_' || r == '-' || r == '+' || r >= '0' && r <= '9' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z') {
			return "dev"
		}
	}
	return value
}

func valueOr(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func masked(value string) string {
	if value == "" {
		return "(not configured)"
	}
	if len(value) <= 12 {
		return value[:3] + "..."
	}
	return value[:8] + "..." + value[len(value)-4:]
}

func defaultServer() string {
	if value := strings.TrimSpace(os.Getenv("BURNFOLIO_SERVER")); value != "" {
		return value
	}
	return "https://burnfolio.ai"
}
