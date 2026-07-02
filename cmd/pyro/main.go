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

	"github.com/nbitslabs/burnfolio/internal/openrouter"
	"github.com/nbitslabs/burnfolio/internal/usage"
)

var version = "dev"

type config struct {
	Profile           string `json:"profile,omitempty"`
	Machine           string `json:"machine,omitempty"`
	Server            string `json:"server,omitempty"`
	Providers         string `json:"providers,omitempty"`
	InstallDir        string `json:"install_dir,omitempty"`
	Installed         bool   `json:"installed"`
	UninstalledAt     string `json:"uninstalled_at,omitempty"`
	LastSyncAt        string `json:"last_sync_at,omitempty"`
	LastSyncStatus    string `json:"last_sync_status,omitempty"`
	LastPyroVersion   string `json:"last_pyro_version,omitempty"`
	OpenRouterKey     string `json:"openrouter_key,omitempty"`
	OpenRouterProfile string `json:"openrouter_profile,omitempty"`
	OpenRouterSince   string `json:"openrouter_since,omitempty"`
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
		home              string
		providers         string
		jsonOutput        bool
		profile           string
		machine           string
		server            string
		noSync            bool
		openRouterKey     string
		openRouterProfile string
		openRouterSince   string
	)

	defaultHome, err := os.UserHomeDir()
	if err != nil {
		defaultHome = ""
	}

	flag.StringVar(&home, "home", defaultHome, "home directory containing agent data")
	defaultProviders := usage.DefaultProviderList()
	flag.StringVar(&providers, "providers", defaultProviders, "comma-separated providers to scan")
	flag.BoolVar(&jsonOutput, "json", false, "print JSON instead of a table")
	flag.StringVar(&profile, "profile", "", "Burnfolio account number or username to sync to")
	flag.StringVar(&machine, "machine", "", "Burnfolio machine token for sync")
	flag.StringVar(&server, "server", defaultServer(), "Burnfolio server URL")
	flag.StringVar(&openRouterKey, "openrouter-key", "", "OpenRouter management key for local usage import")
	flag.StringVar(&openRouterProfile, "openrouter-profile", "", "Burnfolio profile or org for OpenRouter usage")
	flag.StringVar(&openRouterSince, "openrouter-since", "", "first OpenRouter usage date to import, YYYY-MM-DD")
	flag.BoolVar(&noSync, "no-sync", false, "collect and print only; do not sync even when configured")
	flag.BoolVar(&noSync, "no-run", false, "alias for -no-sync")
	flag.Parse()
	providersProvided := flagProvided("providers")

	if home == "" {
		fmt.Fprintln(os.Stderr, "could not determine home directory; pass -home")
		os.Exit(2)
	}

	cfg := loadConfigOrWarn(defaultHome)
	if !providersProvided && cfg.Providers != "" {
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
	if openRouterKey == "" {
		openRouterKey = cfg.OpenRouterKey
	}
	if openRouterProfile == "" {
		openRouterProfile = valueOr(cfg.OpenRouterProfile, profile)
	}
	if openRouterSince == "" {
		openRouterSince = valueOr(cfg.OpenRouterSince, "2020-01-01")
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
		// A one-off "pyro -profile x -machine y" run (as opposed to `pyro
		// install`) still persists these credentials to config.json below
		// so future runs sync automatically. Note that the first time it
		// happens, so it's not a silent, surprising side effect.
		hadCredentials := credentialsAlreadySaved(cfg)
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
		cfg.Installed = true
		cfg.UninstalledAt = ""
		cfg.LastSyncAt = time.Now().UTC().Format(time.RFC3339)
		cfg.LastSyncStatus = syncStatus(result)
		cfg.LastPyroVersion = version
		_ = saveConfig(defaultHome, cfg)
		if !hadCredentials {
			fmt.Printf("Saved profile + machine token to %s (pyro will sync automatically; run 'pyro uninstall' to remove).\n", configPath(defaultHome))
		}
		if result.SkippedDays > 0 {
			fmt.Printf("\nSynced %d days to %s for %s. Skipped %d invalid days.\n", result.UpsertedDays, strings.TrimRight(server, "/"), profile, result.SkippedDays)
		} else {
			fmt.Printf("\nSynced %d days to %s for %s.\n", result.UpsertedDays, strings.TrimRight(server, "/"), profile)
		}
		if strings.TrimSpace(openRouterKey) != "" {
			orResult, err := syncOpenRouterUsage(context.Background(), server, openRouterProfile, machine, openRouterKey, openRouterSince)
			if err != nil {
				cfg.LastSyncStatus = "failed openrouter: " + err.Error()
				_ = saveConfig(defaultHome, cfg)
				fmt.Fprintf(os.Stderr, "openrouter sync failed: %v\n", err)
				os.Exit(1)
			}
			cfg.OpenRouterKey = strings.TrimSpace(openRouterKey)
			cfg.OpenRouterProfile = strings.TrimSpace(openRouterProfile)
			cfg.OpenRouterSince = strings.TrimSpace(openRouterSince)
			cfg.LastSyncStatus += fmt.Sprintf("; openrouter: %d days", orResult.UpsertedDays)
			_ = saveConfig(defaultHome, cfg)
			fmt.Printf("Synced %d OpenRouter days to %s for %s.\n", orResult.UpsertedDays, strings.TrimRight(server, "/"), openRouterProfile)
		}
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

type openRouterPayload struct {
	Profile           string           `json:"profile"`
	OpenRouterKeyHash string           `json:"openrouter_key_hash"`
	Days              []openrouter.Day `json:"days"`
}

type syncResult struct {
	OK           bool   `json:"ok"`
	UpsertedDays int    `json:"upserted_days"`
	SkippedDays  int    `json:"skipped_days"`
	Error        string `json:"error"`
}

func syncStatus(result syncResult) string {
	if result.SkippedDays > 0 {
		return fmt.Sprintf("ok: %d days, %d skipped", result.UpsertedDays, result.SkippedDays)
	}
	return fmt.Sprintf("ok: %d days", result.UpsertedDays)
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

func syncOpenRouterUsage(ctx context.Context, server string, profile string, machineToken string, key string, since string) (syncResult, error) {
	profile = strings.TrimSpace(profile)
	if profile == "" {
		return syncResult{}, fmt.Errorf("openrouter profile is required")
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	days, err := openrouter.Client{Key: key}.DailyUsage(ctx, since, time.Now().UTC())
	if err != nil {
		return syncResult{}, err
	}
	payload := openRouterPayload{
		Profile:           profile,
		OpenRouterKeyHash: openrouter.KeyHash(key),
		Days:              days,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return syncResult{}, err
	}
	endpoint := strings.TrimRight(server, "/") + "/api/openrouter/ingest"
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
	cfg := loadConfigOrWarn(home)
	profile := fs.String("profile", cfg.Profile, "Burnfolio profile")
	machine := fs.String("machine", cfg.Machine, "Burnfolio machine token")
	server := fs.String("server", valueOr(cfg.Server, defaultServer()), "Burnfolio server URL")
	providers := fs.String("providers", valueOr(cfg.Providers, usage.DefaultProviderList()), "providers to scan")
	openRouterKey := fs.String("openrouter-key", cfg.OpenRouterKey, "OpenRouter management key")
	openRouterProfile := fs.String("openrouter-profile", cfg.OpenRouterProfile, "Burnfolio profile or org for OpenRouter usage")
	openRouterSince := fs.String("openrouter-since", valueOr(cfg.OpenRouterSince, "2020-01-01"), "first OpenRouter usage date")
	installDir := fs.String("install-dir", cfg.InstallDir, "install directory")
	schedule := fs.String("schedule", "", "recorded schedule")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg.Profile = strings.TrimSpace(*profile)
	cfg.Machine = strings.TrimSpace(*machine)
	cfg.Server = strings.TrimRight(strings.TrimSpace(*server), "/")
	cfg.Providers = strings.TrimSpace(*providers)
	cfg.OpenRouterKey = strings.TrimSpace(*openRouterKey)
	cfg.OpenRouterProfile = strings.TrimSpace(*openRouterProfile)
	cfg.OpenRouterSince = strings.TrimSpace(*openRouterSince)
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
	cfg := loadConfigOrWarn(home)
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
	cfg := loadConfigOrWarn(home)
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
	fmt.Printf("providers: %s\n", valueOr(cfg.Providers, usage.DefaultProviderList()))
	fmt.Printf("openrouter_key: %s\n", masked(cfg.OpenRouterKey))
	fmt.Printf("openrouter_profile: %s\n", valueOr(cfg.OpenRouterProfile, "(not configured)"))
	fmt.Printf("openrouter_since: %s\n", valueOr(cfg.OpenRouterSince, "2020-01-01"))
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
			cfg.Providers = usage.DefaultProviderList()
			return cfg, nil
		}
		cfg.Server = defaultServer()
		cfg.Providers = usage.DefaultProviderList()
		return cfg, err
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		cfg = config{Server: defaultServer(), Providers: usage.DefaultProviderList()}
		return cfg, err
	}
	if cfg.Server == "" {
		cfg.Server = defaultServer()
	}
	if cfg.Providers == "" {
		cfg.Providers = usage.DefaultProviderList()
	}
	return cfg, nil
}

// loadConfigOrWarn loads the config, falling back to fresh-install defaults
// on error. loadConfig only returns a non-nil error for an existing config
// file that couldn't be read or parsed (a missing file is not an error), so
// this is the "config exists but is broken" case: warn once on stderr
// rather than silently proceeding as if pyro had never been configured.
// credentialsAlreadySaved reports whether cfg already has both a profile
// and machine token on disk, i.e. whether persisting new ones (from a
// one-off "pyro -profile x -machine y" run) would be a no-op change rather
// than the first time credentials are saved.
func credentialsAlreadySaved(cfg config) bool {
	return strings.TrimSpace(cfg.Profile) != "" && strings.TrimSpace(cfg.Machine) != ""
}

func loadConfigOrWarn(home string) config {
	cfg, err := loadConfig(home)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not read %s (%v); continuing with defaults\n", configPath(home), err)
	}
	return cfg
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
	out, err := exec.Command("crontab", "-l").CombinedOutput()
	if err != nil {
		// "no crontab for user" (exit status 1 with that message on most
		// platforms) just means there's nothing to remove. Any other
		// failure (permission error, transient issue, etc.) must abort
		// without touching the user's crontab.
		if strings.Contains(strings.ToLower(string(out)), "no crontab for") {
			return nil
		}
		return fmt.Errorf("crontab -l failed, leaving crontab untouched: %w", err)
	}
	var original, kept []string
	for _, line := range strings.Split(string(out), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		original = append(original, line)
		if profile != "" && strings.Contains(line, "# burnfolio-pyro "+profile) {
			continue
		}
		if profile == "" && strings.Contains(line, "# burnfolio-pyro ") {
			continue
		}
		kept = append(kept, line)
	}
	if len(kept) == len(original) {
		// Nothing to remove; skip the write entirely.
		return nil
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

func flagProvided(name string) bool {
	return flagSetProvided(flag.CommandLine, name)
}

func flagSetProvided(fs *flag.FlagSet, name string) bool {
	found := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == name {
			found = true
		}
	})
	return found
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
		if len(value) <= 3 {
			return strings.Repeat("*", len(value))
		}
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
