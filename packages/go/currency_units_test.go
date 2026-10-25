package apphealth

import (
	"os"
	"regexp"
	"strconv"
	"testing"
)

func TestProductCurrenciesMatchCanonicalISOTable(t *testing.T) {
	source, err := os.ReadFile("../contracts/src/currency-minor-units.ts")
	if os.IsNotExist(err) {
		t.Skip("canonical workspace source absent in standalone SDK module")
	}
	if err != nil {
		t.Fatal(err)
	}
	matches := regexp.MustCompile(`(?m)^  ([A-Z]{3}): ([0-4]),`).FindAllStringSubmatch(string(source), -1)
	if len(matches) != len(productCurrencyUnits) {
		t.Fatal("currency table drift; run node scripts/generate-currency-units.mjs")
	}
	for _, match := range matches {
		exponent, _ := strconv.Atoi(match[2])
		value, ok := productCurrencyUnits[match[1]]
		if !ok || value != exponent {
			t.Fatalf("currency %s drifted", match[1])
		}
	}
}
