import { useState, useEffect, useCallback } from "react";
import { Search, Package, Truck, DollarSign, FileText, X, MapPin, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useMockData } from "@/lib/mock-data-store";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth-context";

interface MockCarrier {
  id: string;
  name: string;
  mcNumber: string;
  location: string;
  fleet: string;
  status: string;
}

const staticCarriers: MockCarrier[] = [
  { id: "car-1", name: "Sharma Transport", mcNumber: "IND-123456", location: "Mumbai, Maharashtra", fleet: "35 Trucks", status: "Approved" },
  { id: "car-2", name: "Patel Logistics", mcNumber: "IND-789012", location: "Ahmedabad, Gujarat", fleet: "22 Trucks", status: "Approved" },
  { id: "car-3", name: "Singh Freight Co", mcNumber: "IND-345678", location: "Delhi, Delhi", fleet: "18 Trucks", status: "Pending" },
  { id: "car-4", name: "Gupta Express", mcNumber: "IND-901234", location: "Jaipur, Rajasthan", fleet: "12 Trucks", status: "Approved" },
  { id: "car-5", name: "Kumar Carriers", mcNumber: "IND-567890", location: "Bangalore, Karnataka", fleet: "28 Trucks", status: "Approved" },
];

interface SearchResult {
  id: string;
  type: "load" | "carrier" | "bid" | "document";
  title: string;
  subtitle: string;
  route?: string;
  status?: string;
  statusVariant?: "default" | "secondary" | "destructive" | "outline";
}

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const { loads, bids } = useMockData();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const carriers = staticCarriers;
  const isShipper = user?.role === "shipper";

  const searchAll = useCallback((searchQuery: string) => {
    if (!searchQuery.trim()) {
      setResults([]);
      return;
    }

    const q = searchQuery.toLowerCase();
    const searchResults: SearchResult[] = [];

    loads.forEach((load) => {
      if (
        load.loadId.toLowerCase().includes(q) ||
        load.pickup.toLowerCase().includes(q) ||
        load.drop.toLowerCase().includes(q) ||
        load.cargoDescription.toLowerCase().includes(q) ||
        load.status.toLowerCase().includes(q)
      ) {
        searchResults.push({
          id: load.loadId,
          type: "load",
          title: load.loadId,
          subtitle: `${load.pickup} → ${load.drop}`,
          route: `/shipper/loads/${load.loadId}`,
          status: load.status,
          statusVariant: load.status === "Active" || load.status === "Bidding" 
            ? "default" 
            : load.status === "Delivered" 
            ? "secondary" 
            : "outline",
        });
      }
    });

    if (!isShipper) {
      bids.forEach((bid) => {
        if (
          bid.bidId.toLowerCase().includes(q) ||
          bid.carrierName.toLowerCase().includes(q) ||
          bid.loadId.toLowerCase().includes(q) ||
          bid.status.toLowerCase().includes(q)
        ) {
          searchResults.push({
            id: bid.bidId,
            type: "bid",
            title: `${bid.carrierName} - $${bid.bidPrice.toLocaleString()}`,
            subtitle: `Bid on ${bid.loadId}`,
            route: `/admin/bids`,
            status: bid.status,
            statusVariant: bid.status === "Pending" 
              ? "default" 
              : bid.status === "Accepted" 
              ? "secondary"
              : bid.status === "Countered"
              ? "outline"
              : "destructive",
          });
        }
      });

      carriers.forEach((carrier) => {
        if (
          carrier.name.toLowerCase().includes(q) ||
          carrier.mcNumber.toLowerCase().includes(q) ||
          carrier.location.toLowerCase().includes(q) ||
          carrier.fleet.toLowerCase().includes(q)
        ) {
          searchResults.push({
            id: carrier.id,
            type: "carrier",
            title: carrier.name,
            subtitle: `${carrier.location} • ${carrier.fleet}`,
            route: `/admin/carriers`,
            status: carrier.status,
            statusVariant: carrier.status === "Approved" ? "secondary" : "outline",
          });
        }
      });
    }

    const mockDocuments = [
      { id: "doc-1", name: "Bill of Lading - LD-001", type: "BOL", loadId: "LD-001" },
      { id: "doc-2", name: "Proof of Delivery - LD-T002", type: "POD", loadId: "LD-T002" },
      { id: "doc-3", name: "Memo - MM-001", type: "Memo", loadId: "LD-001" },
      { id: "doc-4", name: "Rate Confirmation - LD-003", type: "Rate Conf", loadId: "LD-003" },
    ];

    mockDocuments.forEach((doc) => {
      if (
        doc.name.toLowerCase().includes(q) ||
        doc.type.toLowerCase().includes(q) ||
        doc.loadId.toLowerCase().includes(q)
      ) {
        searchResults.push({
          id: doc.id,
          type: "document",
          title: doc.name,
          subtitle: `${doc.type} • ${doc.loadId}`,
          route: `/shipper/documents`,
          status: doc.type,
        });
      }
    });

    setResults(searchResults.slice(0, 10));
  }, [loads, bids, carriers, isShipper]);

  useEffect(() => {
    const delayedSearch = setTimeout(() => {
      searchAll(query);
    }, 150);

    return () => clearTimeout(delayedSearch);
  }, [query, searchAll]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSelect = (result: SearchResult) => {
    if (result.route) {
      setLocation(result.route);
    }
    setOpen(false);
    setQuery("");
  };

  const getIcon = (type: SearchResult["type"]) => {
    switch (type) {
      case "load":
        return <Package className="h-4 w-4 text-primary" />;
      case "carrier":
        return <Truck className="h-4 w-4 text-blue-500" />;
      case "bid":
        return <DollarSign className="h-4 w-4 text-green-500" />;
      case "document":
        return <FileText className="h-4 w-4 text-amber-500" />;
    }
  };

  const getTypeLabel = (type: SearchResult["type"]) => {
    switch (type) {
      case "load":
        return "Load";
      case "carrier":
        return "Carrier";
      case "bid":
        return "Bid";
      case "document":
        return "Document";
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-2 text-muted-foreground w-full sm:w-64 justify-start"
        onClick={() => setOpen(true)}
        data-testid="button-global-search"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left truncate text-xs sm:text-sm">{isShipper ? "Search loads..." : "Search..."}</span>
        <kbd className="pointer-events-none hidden sm:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
          <span className="text-xs">Ctrl</span>K
        </kbd>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="p-0 max-w-lg overflow-hidden">
          <DialogHeader className="sr-only">
            <DialogTitle>Global Search</DialogTitle>
          </DialogHeader>
          <div className="flex items-center border-b px-3">
            <Search className="h-4 w-4 text-muted-foreground mr-2 shrink-0" />
            <Input
              placeholder={isShipper ? "Search loads, documents..." : "Search loads, carriers, bids, documents..."}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="border-0 focus-visible:ring-0 flex-1"
              data-testid="input-global-search"
              autoFocus
            />
            {query && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setQuery("")}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>

          <ScrollArea className="max-h-[300px]">
            {results.length === 0 && query && (
              <div className="p-8 text-center text-muted-foreground">
                <Search className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No results found for "{query}"</p>
                <p className="text-sm mt-1">{isShipper ? "Try searching for load IDs or routes" : "Try searching for load IDs, carrier names, or routes"}</p>
              </div>
            )}

            {results.length === 0 && !query && (
              <div className="p-4 space-y-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Quick Actions</p>
                <div className="space-y-1">
                  {isShipper ? (
                    <>
                      <button
                        className="w-full flex items-center gap-3 p-2 rounded-md hover-elevate text-left"
                        onClick={() => { setLocation("/shipper/post-load"); setOpen(false); }}
                        data-testid="search-quick-post-load"
                      >
                        <Package className="h-4 w-4 text-primary" />
                        <span className="text-sm">Post a new load</span>
                        <ArrowRight className="h-3 w-3 ml-auto text-muted-foreground" />
                      </button>
                      <button
                        className="w-full flex items-center gap-3 p-2 rounded-md hover-elevate text-left"
                        onClick={() => { setLocation("/shipper/loads"); setOpen(false); }}
                        data-testid="search-quick-my-loads"
                      >
                        <Package className="h-4 w-4 text-blue-500" />
                        <span className="text-sm">View my loads</span>
                        <ArrowRight className="h-3 w-3 ml-auto text-muted-foreground" />
                      </button>
                      <button
                        className="w-full flex items-center gap-3 p-2 rounded-md hover-elevate text-left"
                        onClick={() => { setLocation("/shipper/tracking"); setOpen(false); }}
                        data-testid="search-quick-tracking"
                      >
                        <MapPin className="h-4 w-4 text-green-500" />
                        <span className="text-sm">Track shipments</span>
                        <ArrowRight className="h-3 w-3 ml-auto text-muted-foreground" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="w-full flex items-center gap-3 p-2 rounded-md hover-elevate text-left"
                        onClick={() => { setLocation("/admin/load-queue"); setOpen(false); }}
                        data-testid="search-quick-load-queue"
                      >
                        <Package className="h-4 w-4 text-primary" />
                        <span className="text-sm">View load queue</span>
                        <ArrowRight className="h-3 w-3 ml-auto text-muted-foreground" />
                      </button>
                      <button
                        className="w-full flex items-center gap-3 p-2 rounded-md hover-elevate text-left"
                        onClick={() => { setLocation("/admin/carriers"); setOpen(false); }}
                        data-testid="search-quick-carriers"
                      >
                        <Truck className="h-4 w-4 text-blue-500" />
                        <span className="text-sm">Manage carriers</span>
                        <ArrowRight className="h-3 w-3 ml-auto text-muted-foreground" />
                      </button>
                      <button
                        className="w-full flex items-center gap-3 p-2 rounded-md hover-elevate text-left"
                        onClick={() => { setLocation("/admin/bids"); setOpen(false); }}
                        data-testid="search-quick-bids"
                      >
                        <DollarSign className="h-4 w-4 text-green-500" />
                        <span className="text-sm">View bids</span>
                        <ArrowRight className="h-3 w-3 ml-auto text-muted-foreground" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            {results.length > 0 && (
              <div className="p-2">
                {results.map((result) => (
                  <button
                    key={`${result.type}-${result.id}`}
                    className="w-full flex items-center gap-3 p-2 rounded-md hover-elevate text-left"
                    onClick={() => handleSelect(result)}
                    data-testid={`search-result-${result.type}-${result.id}`}
                  >
                    {getIcon(result.type)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{result.title}</span>
                        <Badge variant="outline" className="text-[10px] px-1 h-4 no-default-hover-elevate no-default-active-elevate">
                          {getTypeLabel(result.type)}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{result.subtitle}</p>
                    </div>
                    {result.status && (
                      <Badge 
                        variant={result.statusVariant || "secondary"} 
                        className="text-xs shrink-0 no-default-hover-elevate no-default-active-elevate"
                      >
                        {result.status}
                      </Badge>
                    )}
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>

          <div className="border-t p-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>Type to search across all data</span>
            <span>Press <kbd className="px-1 rounded bg-muted">Esc</kbd> to close</span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
