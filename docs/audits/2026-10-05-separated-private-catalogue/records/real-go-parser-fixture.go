package httpapi

import (
 "encoding/json"
 "os"
 "testing"
)

func TestIntegrationShippingCatalogueNegotiations(t *testing.T) {
 raw, err := os.ReadFile(os.Getenv("OXY_QUERY_GOLDEN_PATH")); if err != nil { t.Fatal(err) }
 var captured []struct { Path string `json:"path"`; Body string `json:"body"` }
 if err := json.Unmarshal(raw, &captured); err != nil { t.Fatal(err) }
 if len(captured) != 6 { t.Fatalf("wanted six shipping read bodies, got %d", len(captured)) }
 for i, capture := range captured {
  parsed, err := parseDeploymentDescriptorQuery([]byte(capture.Body)); if err != nil { t.Fatalf("shipping query %d refused: %v", i, err) }
  if (parsed.ScopedExecutionContractVersion != "") == (parsed.PrivateAutoExecutionContractVersion != "") { t.Fatal("query must negotiate one extension") }
 }
 for _, bad := range []string{
  `{"scopedExecutionContractVersion":"3.6.0","privateAutoExecutionContractVersion":"3.7.0"}`,
  `{"privateAutoExecutionContractVersion":"3.7.0","privateAutoExecutionContractVersion":"3.7.0"}`,
  `{"scopedExecutionContractVersion":"3.6.0","scope":{}}`,
 } { if _, err := parseDeploymentDescriptorQuery([]byte(bad)); err == nil { t.Fatal("ambiguous query accepted") } }
}
