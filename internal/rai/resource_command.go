package rai

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"text/tabwriter"
)

// New singular resources use human output by default. Legacy plural commands
// keep their JSON contract for existing scripts.
func (a *App) resourceCommand(ctx context.Context, profile string, args []string) error {
	resource := args[0]
	rest, asJSON, help, err := resourceOutputFlags(args[1:])
	if err != nil {
		return err
	}
	if help || len(rest) == 0 {
		return a.resourceHelp(resource)
	}
	operation := rest[0]
	valid := operation == "list" || (resource == "key" && (operation == "create" || operation == "update" || operation == "delete")) || (resource == "device" && operation == "revoke")
	if !valid {
		return fmt.Errorf("unknown %s command %q; see rai %s --help", resource, operation, resource)
	}
	print := a.printManagementJSON
	if !asJSON {
		print = func(value any) error { return a.printResourceResult(resource, rest, value) }
	}
	command := append([]string{resource + "s"}, rest...)
	return a.manageWithOutput(ctx, profile, command, print)
}

func resourceOutputFlags(args []string) (rest []string, asJSON, help bool, err error) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		name, value, hasValue := strings.Cut(arg, "=")
		switch {
		case arg == "--":
			rest = append(rest, args[i:]...)
			return
		case isHelp(arg):
			help = true
		case name == "--json":
			asJSON = true
			if hasValue {
				asJSON, err = strconv.ParseBool(value)
				if err != nil {
					err = errors.New("--json expects true or false")
					return
				}
			}
		default:
			rest = append(rest, arg)
			// Preserve flag values literally, including names such as "--json".
			if !hasValue && (name == "--name" || name == "--models" || name == "--aliases" || name == "--rpm" || name == "--daily-tokens") && i+1 < len(args) {
				i++
				rest = append(rest, args[i])
			}
		}
	}
	return
}

func (a *App) printResourceResult(resource string, args []string, value any) error {
	if args[0] == "delete" || args[0] == "revoke" {
		a.terminal(a.Stdout).message("success", "Revoked %s %s", resource, args[1])
		return nil
	}
	obj, ok := value.(map[string]any)
	if !ok {
		return errors.New("invalid resource response")
	}
	if args[0] != "list" {
		item, ok := obj["item"].(map[string]any)
		if !ok {
			return errors.New("invalid Key response")
		}
		verb := "Created"
		if args[0] == "update" {
			verb = "Updated"
		}
		ui := a.terminal(a.Stdout)
		ui.message("success", "%s Key %s", verb, terminalText(resourceValue(item["name"])))
		ui.field("ID", terminalText(resourceValue(item["id"])))
		if secret, ok := obj["key"].(string); ok {
			ui.field("Key", terminalText(secret))
		}
		return nil
	}
	items, ok := obj["items"].([]any)
	// A nil slice is encoded as null by some existing servers.
	if !ok && obj["items"] != nil {
		return errors.New("invalid resource list")
	}
	if len(items) == 0 {
		fmt.Fprintf(a.Stdout, "No %ss found.\n", resource)
		return nil
	}
	columns := []string{"id", "name", "enabled", "model_allowlist", "rate_limit_per_minute", "token_limit_daily"}
	headers := []string{"ID", "NAME", "ENABLED", "MODELS", "RPM", "DAILY TOKENS"}
	if resource == "device" {
		columns = []string{"id", "device_name", "purpose", "enabled", "last_used_at", "expires_at"}
		headers = []string{"ID", "DEVICE", "SCOPE", "ENABLED", "LAST USED", "EXPIRES"}
	}
	// Validate before writing, so a malformed response cannot produce a partial table.
	rows := make([][]string, 0, len(items))
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			return errors.New("invalid resource list item")
		}
		row := make([]string, len(columns))
		for i, column := range columns {
			row[i] = terminalText(resourceValue(item[column]))
		}
		rows = append(rows, row)
	}
	table := tabwriter.NewWriter(a.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(table, strings.Join(headers, "\t"))
	for _, row := range rows {
		fmt.Fprintln(table, strings.Join(row, "\t"))
	}
	return table.Flush()
}

func resourceValue(value any) string {
	if value == nil {
		return "-"
	}
	if values, ok := value.([]any); ok {
		if len(values) == 0 {
			return "-"
		}
		parts := make([]string, len(values))
		for i, v := range values {
			parts[i] = resourceValue(v)
		}
		return strings.Join(parts, ",")
	}
	if value == "" {
		return "-"
	}
	return fmt.Sprint(value)
}
