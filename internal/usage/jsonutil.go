package usage

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type object map[string]any

func readJSONL(path string, handle func(line int, obj object) error) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	buf := make([]byte, 0, 1024*1024)
	scanner.Buffer(buf, 32*1024*1024)

	line := 0
	for scanner.Scan() {
		line++
		raw := bytes.TrimSpace(scanner.Bytes())
		if len(raw) == 0 {
			continue
		}
		obj, err := decodeObject(raw)
		if err != nil {
			return fmt.Errorf("%s:%d: %w", path, line, err)
		}
		if err := handle(line, obj); err != nil {
			return fmt.Errorf("%s:%d: %w", path, line, err)
		}
	}
	return scanner.Err()
}

func decodeObject(raw []byte) (object, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var obj object
	if err := dec.Decode(&obj); err != nil {
		return nil, err
	}
	return obj, nil
}

func decodeJSONFile(path string) (object, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	dec := json.NewDecoder(file)
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		if errors.Is(err, io.EOF) {
			return object{}, nil
		}
		return nil, err
	}
	obj, ok := asObject(value)
	if !ok {
		return object{}, nil
	}
	return obj, nil
}

func getObject(root object, path ...string) object {
	var cur any = root
	for _, key := range path {
		obj, ok := asObject(cur)
		if !ok {
			return nil
		}
		cur = obj[key]
	}
	if obj, ok := asObject(cur); ok {
		return obj
	}
	return nil
}

func getString(root object, path ...string) string {
	var cur any = root
	for _, key := range path {
		obj, ok := asObject(cur)
		if !ok {
			return ""
		}
		cur = obj[key]
	}
	switch v := cur.(type) {
	case string:
		return v
	case json.Number:
		return v.String()
	default:
		return ""
	}
}

func getInt(root object, path ...string) int64 {
	var cur any = root
	for _, key := range path {
		obj, ok := asObject(cur)
		if !ok {
			return 0
		}
		cur = obj[key]
	}
	return anyInt(cur)
}

func getFloat(root object, path ...string) float64 {
	var cur any = root
	for _, key := range path {
		obj, ok := asObject(cur)
		if !ok {
			return 0
		}
		cur = obj[key]
	}
	switch v := cur.(type) {
	case json.Number:
		f, _ := v.Float64()
		return f
	case float64:
		return v
	case int64:
		return float64(v)
	case int:
		return float64(v)
	default:
		return 0
	}
}

func asObject(value any) (object, bool) {
	switch obj := value.(type) {
	case object:
		return obj, true
	case map[string]any:
		return object(obj), true
	default:
		return nil, false
	}
}

func anyInt(value any) int64 {
	switch v := value.(type) {
	case json.Number:
		i, err := v.Int64()
		if err == nil {
			return i
		}
		f, err := v.Float64()
		if err == nil {
			return int64(f)
		}
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	case string:
		i, _ := strconv.ParseInt(v, 10, 64)
		return i
	}
	return 0
}

func parseTimePtr(raw string) *time.Time {
	if raw == "" {
		return nil
	}
	layouts := []string{time.RFC3339Nano, time.RFC3339}
	for _, layout := range layouts {
		t, err := time.Parse(layout, raw)
		if err == nil {
			return &t
		}
	}
	return nil
}

func walkFiles(root string, shouldInclude func(path string) bool, handle func(path string) error) error {
	info, err := os.Stat(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !info.IsDir() {
		if shouldInclude(root) {
			return handle(root)
		}
		return nil
	}

	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			base := d.Name()
			if base == "node_modules" || base == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if shouldInclude(path) {
			return handle(path)
		}
		return nil
	})
}

func hasExt(path string, exts ...string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	for _, candidate := range exts {
		if ext == candidate {
			return true
		}
	}
	return false
}
