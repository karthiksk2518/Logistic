import { useState, useEffect, useCallback, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { 
  MapPin, Truck, Package, Phone, Mail, Building2, User, 
  Navigation, Clock, RefreshCw, Loader2, Eye,
  Radio, CheckCircle, AlertCircle, ArrowRight, X, ChevronLeft, List, Calendar,
  PauseCircle, XCircle, DollarSign, FileText
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface TrackedShipment {
  id: string;
  loadId: string;
  status: string;
  progress: number;
  currentStage: string;
  createdAt: string;
  startedAt: string | null;
  eta: string | null;
  currentLocation: {
    lat: number | null;
    lng: number | null;
    address: string | null;
  };
  otp: {
    startRequested: boolean;
    startVerified: boolean;
    endRequested: boolean;
    endVerified: boolean;
  };
  load: {
    id: string;
    referenceNumber: number | null;
    pickupCity: string;
    pickupAddress: string;
    pickupState: string | null;
    dropoffCity: string;
    dropoffAddress: string;
    dropoffState: string | null;
    materialType: string | null;
    weight: string;
    requiredTruckType: string | null;
    pickupDate: string | null;
    deliveryDate: string | null;
  } | null;
  shipper: {
    id: string;
    username: string;
    companyName: string;
    contactName: string;
    phone: string | null;
    email: string | null;
    address: string | null;
  } | null;
  receiver: {
    name: string | null;
    phone: string | null;
    email: string | null;
    businessName: string | null;
    address: string | null;
    city: string | null;
  } | null;
  carrier: {
    id: string;
    username: string;
    companyName: string;
    phone: string | null;
    carrierType: string;
  } | null;
  driver: {
    name: string;
    phone: string | null;
  } | null;
  truck: {
    id: string;
    registrationNumber: string;
    truckType: string;
    capacity: number;
  } | null;
  timeline: {
    stage: string;
    completed: boolean;
    timestamp: string | null;
    location: string;
  }[];
  documents: {
    id: string;
    documentType: string;
    fileName: string;
    fileUrl: string | null;
    fileSize: number | null;
    isVerified: boolean | null;
    createdAt: string | null;
  }[];
  financeReview: {
    id: string;
    status: string;
    comment: string | null;
    paymentStatus: string;
    reviewedAt: string | null;
    reviewerName: string;
  } | null;
}

const stageLabels: Record<string, string> = {
  pickup_scheduled: "Awaiting Pickup",
  at_pickup: "At Pickup Location",
  in_transit: "In Transit",
  delivered: "Delivered",
};

const timelineStageLabels: Record<string, string> = {
  load_created: "Load Created",
  carrier_assigned: "Carrier Assigned",
  reached_pickup: "Reached Pickup",
  loaded: "Loaded",
  in_transit: "In Transit",
  arrived_at_drop: "Arrived at Drop",
  delivered: "Delivered",
};

const documentTypeLabels: Record<string, string> = {
  lr_consignment: "LR / Consignment Note",
  eway_bill: "E-way Bill",
  loading_photos: "Loading Photos",
  pod: "Proof of Delivery (POD)",
  invoice: "Invoice",
  other: "Other Document",
};

const stageBadgeColors: Record<string, string> = {
  pickup_scheduled: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  at_pickup: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  in_transit: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  delivered: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
};

// Create custom truck icon
const createTruckIcon = (isLive: boolean, isSelected: boolean) => {
  const color = isLive ? "#22c55e" : "#6b7280";
  const size = isSelected ? 40 : 32;
  return L.divIcon({
    html: `<div style="
      background: ${color};
      width: ${size}px;
      height: ${size}px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 3px solid white;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      ${isSelected ? 'transform: scale(1.2);' : ''}
    ">
      <svg width="${size * 0.5}" height="${size * 0.5}" viewBox="0 0 24 24" fill="white">
        <path d="M18 18.5a1.5 1.5 0 1 1-1.5-1.5 1.5 1.5 0 0 1 1.5 1.5zm-12 0A1.5 1.5 0 1 1 4.5 17 1.5 1.5 0 0 1 6 18.5zM21 12v4a1 1 0 0 1-1 1h-1a3 3 0 0 0-6 0H9a3 3 0 0 0-6 0H2a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v4h2l3 4h2z"/>
      </svg>
    </div>`,
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

// Component to fit map bounds to markers on initial load only
function FitBoundsToMarkers({ positions }: { positions: [number, number][] }) {
  const map = useMap();
  const [hasFitBounds, setHasFitBounds] = useState(false);
  
  useEffect(() => {
    if (!hasFitBounds && positions.length > 0) {
      const bounds = L.latLngBounds(positions.map(p => L.latLng(p[0], p[1])));
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 10 });
      setHasFitBounds(true);
    }
  }, [map, positions, hasFitBounds]);
  
  return null;
}

// Component to center map on selected shipment
function CenterOnShipment({ position }: { position: [number, number] | null }) {
  const map = useMap();
  
  useEffect(() => {
    if (position) {
      map.flyTo(position, 12, { duration: 0.5 });
    }
  }, [position?.[0], position?.[1]]);
  
  return null;
}

const reviewStatusConfig: Record<string, { label: string; color: string; icon: typeof CheckCircle }> = {
  pending: { label: "Pending Review", color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400", icon: Clock },
  approved: { label: "Approved", color: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400", icon: CheckCircle },
  on_hold: { label: "On Hold", color: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400", icon: PauseCircle },
  rejected: { label: "Rejected", color: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400", icon: XCircle },
};

const paymentStatusConfig: Record<string, { label: string; color: string }> = {
  not_released: { label: "Not Released", color: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400" },
  processing: { label: "Processing", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400" },
  released: { label: "Released", color: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" },
};

export default function AdminLiveTrackingPage() {
  const { toast } = useToast();
  const [selectedShipment, setSelectedShipment] = useState<TrackedShipment | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [stageFilter, setStageFilter] = useState<string>("all");
  const [telemetryData, setTelemetryData] = useState<Record<string, { lat: number; lng: number; speed?: number }>>({});
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [reviewComment, setReviewComment] = useState("");

  const { data: shipments = [], isLoading, refetch, isRefetching } = useQuery<TrackedShipment[]>({
    queryKey: ["/api/admin/live-tracking"],
    refetchInterval: 30000,
  });

  const reviewMutation = useMutation({
    mutationFn: async (data: { shipmentId: string; loadId: string; status: string; comment: string }) => {
      const res = await apiRequest("POST", "/api/finance/reviews", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/live-tracking"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/shipments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/reviews/all"] });
      toast({ title: "Review Submitted", description: "Document review has been recorded." });
      setReviewComment("");
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to submit review.", variant: "destructive" });
    },
  });

  const paymentMutation = useMutation({
    mutationFn: async (data: { reviewId: string; paymentStatus: string }) => {
      const res = await apiRequest("PATCH", `/api/finance/reviews/${data.reviewId}/payment`, { paymentStatus: data.paymentStatus });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/live-tracking"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/shipments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/reviews/all"] });
      toast({ title: "Payment Updated", description: "Payment status has been updated." });
    },
  });

  const verifyDocumentMutation = useMutation({
    mutationFn: async (data: { documentId: string; isVerified: boolean }) => {
      const res = await apiRequest("PATCH", `/api/admin/documents/${data.documentId}/verify`, { isVerified: data.isVerified });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/live-tracking"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/shipments"] });
      toast({ title: "Document Approved", description: "Document has been verified and is now visible for review." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to verify document.", variant: "destructive" });
    },
  });

  const handleReview = (status: string) => {
    if (!selectedShipment || !selectedShipment.load) return;
    reviewMutation.mutate({
      shipmentId: selectedShipment.id,
      loadId: selectedShipment.loadId,
      status,
      comment: reviewComment,
    });
  };

  // Connect to telemetry WebSocket for real-time updates
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${protocol}//${window.location.host}/ws/telemetry`);

      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: "subscribe", all: true }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "position_update" && data.vehicleId) {
            setTelemetryData(prev => ({
              ...prev,
              [data.vehicleId]: {
                lat: data.lat,
                lng: data.lng,
                speed: data.speed,
              }
            }));
          }
        } catch (e) {
          console.error("Failed to parse telemetry message:", e);
        }
      };

      ws.onclose = () => {
        reconnectTimeout = setTimeout(connect, 5000);
      };
    };

    connect();

    return () => {
      ws?.close();
      clearTimeout(reconnectTimeout);
    };
  }, []);

  // Apply filters
  const filteredShipments = shipments.filter(shipment => {
    const matchesSearch = searchQuery === "" || 
      shipment.load?.referenceNumber?.toString().includes(searchQuery) ||
      shipment.load?.pickupCity?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      shipment.load?.dropoffCity?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      shipment.shipper?.companyName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      shipment.carrier?.companyName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      shipment.truck?.registrationNumber?.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesStage = stageFilter === "all" || shipment.currentStage === stageFilter;
    
    return matchesSearch && matchesStage;
  });

  // Stats
  const stats = {
    total: shipments.length,
    inTransit: shipments.filter(s => s.currentStage === "in_transit").length,
    atPickup: shipments.filter(s => s.currentStage === "at_pickup").length,
    awaiting: shipments.filter(s => s.currentStage === "pickup_scheduled").length,
    delivered: shipments.filter(s => s.currentStage === "delivered").length,
  };

  const handleSelectShipment = useCallback((shipment: TrackedShipment) => {
    setSelectedShipment(shipment);
    setReviewComment(shipment.financeReview?.comment || "");
  }, []);

  // Get position for a shipment (from telemetry or fallback)
  const getShipmentPosition = useCallback((shipment: TrackedShipment): [number, number] | null => {
    const telemetry = telemetryData[shipment.truck?.registrationNumber || ""];
    if (telemetry) {
      return [telemetry.lat, telemetry.lng];
    }
    if (shipment.currentLocation?.lat && shipment.currentLocation?.lng) {
      return [shipment.currentLocation.lat, shipment.currentLocation.lng];
    }
    return null;
  }, [telemetryData]);

  // Get all marker positions for bounds fitting
  const markerPositions = useMemo(() => {
    return filteredShipments
      .map(s => getShipmentPosition(s))
      .filter((p): p is [number, number] => p !== null);
  }, [filteredShipments, getShipmentPosition]);

  // Selected shipment position for centering
  const selectedPosition = selectedShipment ? getShipmentPosition(selectedShipment) : null;

  const getLocationDisplay = (shipment: TrackedShipment) => {
    const telemetry = telemetryData[shipment.truck?.registrationNumber || ""];
    if (telemetry) {
      return `${telemetry.lat.toFixed(4)}, ${telemetry.lng.toFixed(4)}${telemetry.speed ? ` @ ${telemetry.speed.toFixed(0)} km/h` : ""}`;
    }
    if (shipment.currentLocation?.address) {
      return shipment.currentLocation.address;
    }
    if (shipment.currentLocation?.lat && shipment.currentLocation?.lng) {
      return `${shipment.currentLocation.lat.toFixed(4)}, ${shipment.currentLocation.lng.toFixed(4)}`;
    }
    return "Location updating...";
  };

  // India center for default view
  const defaultCenter: [number, number] = [20.5937, 78.9629];

  return (
    <div className="flex h-full relative" data-testid="page-admin-live-tracking">
      {/* Collapsible Side Panel */}
      <div 
        className={`
          absolute top-0 left-0 h-full z-[1000] bg-background border-r shadow-lg
          transition-transform duration-300 ease-in-out
          ${isPanelOpen ? 'translate-x-0' : '-translate-x-full'}
          w-[400px]
        `}
      >
        <div className="flex flex-col h-full">
          {/* Panel Header */}
          <div className="flex items-center justify-between p-4 border-b">
            <div>
              <h1 className="text-lg font-bold">Live Tracking</h1>
              <p className="text-xs text-muted-foreground">{stats.total} shipments</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => refetch()}
                disabled={isRefetching}
                data-testid="button-refresh"
              >
                {isRefetching ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsPanelOpen(false)}
                data-testid="button-close-panel"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Stats Row */}
          <div className="grid grid-cols-5 gap-1 p-3 border-b bg-muted/30">
            <div className="text-center">
              <p className="text-lg font-bold">{stats.total}</p>
              <p className="text-[10px] text-muted-foreground">Total</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-bold text-yellow-600">{stats.awaiting}</p>
              <p className="text-[10px] text-muted-foreground">Awaiting</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-bold text-blue-600">{stats.atPickup}</p>
              <p className="text-[10px] text-muted-foreground">At Pickup</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-bold text-green-600">{stats.inTransit}</p>
              <p className="text-[10px] text-muted-foreground">In Transit</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-bold text-gray-600">{stats.delivered}</p>
              <p className="text-[10px] text-muted-foreground">Delivered</p>
            </div>
          </div>

          {/* Filters */}
          <div className="flex items-center flex-wrap gap-2 p-3 border-b">
            <Input
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 text-sm flex-1 min-w-[120px]"
              data-testid="input-search"
            />
            <Select value={stageFilter} onValueChange={setStageFilter}>
              <SelectTrigger className="w-[130px] h-8" data-testid="select-stage-filter">
                <SelectValue placeholder="Filter" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="pickup_scheduled">Awaiting</SelectItem>
                <SelectItem value="at_pickup">At Pickup</SelectItem>
                <SelectItem value="in_transit">In Transit</SelectItem>
                <SelectItem value="delivered">Delivered</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Shipment List */}
          <ScrollArea className="flex-1">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredShipments.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Truck className="h-12 w-12 mb-4 opacity-50" />
                <p>No shipments found</p>
              </div>
            ) : (
              <div className="divide-y">
                {filteredShipments.map((shipment) => {
                  const isSelected = selectedShipment?.id === shipment.id;
                  const hasLive = !!telemetryData[shipment.truck?.registrationNumber || ""];
                  
                  return (
                    <div
                      key={shipment.id}
                      className={`p-3 cursor-pointer transition-colors ${
                        isSelected ? 'bg-primary/10 border-l-4 border-l-primary' : 'hover:bg-muted/50'
                      }`}
                      onClick={() => handleSelectShipment(shipment)}
                      data-testid={`shipment-row-${shipment.id}`}
                    >
                      <div className="flex items-start gap-3">
                        <div className={`
                          w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0
                          ${hasLive ? 'bg-green-100 dark:bg-green-900/30' : 'bg-muted'}
                        `}>
                          <Truck className={`h-4 w-4 ${hasLive ? 'text-green-600' : 'text-muted-foreground'}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-semibold text-sm">
                              LD-{shipment.load?.referenceNumber ? String(shipment.load.referenceNumber).padStart(3, "0") : "???"}
                            </span>
                            <Badge className={`text-[10px] px-1.5 py-0 ${stageBadgeColors[shipment.currentStage] || ""}`}>
                              {stageLabels[shipment.currentStage]?.split(" ")[0] || shipment.currentStage}
                            </Badge>
                            {hasLive && (
                              <Radio className="h-3 w-3 text-green-500 animate-pulse" />
                            )}
                          </div>
                          
                          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                            <span className="truncate">{shipment.load?.pickupCity}</span>
                            <ArrowRight className="h-3 w-3 flex-shrink-0" />
                            <span className="truncate">{shipment.load?.dropoffCity}</span>
                          </div>

                          <div className="text-[11px] text-muted-foreground">
                            {shipment.truck?.registrationNumber || "No truck"} • {shipment.carrier?.companyName?.substring(0, 20) || "N/A"}
                          </div>
                          {shipment.load?.pickupDate && (
                            <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-0.5">
                              <Calendar className="h-3 w-3" />
                              <span>Pickup: {format(new Date(shipment.load.pickupDate), "dd MMM yyyy")}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </div>
      </div>

      {/* Toggle Panel Button (when closed) */}
      {!isPanelOpen && (
        <Button
          variant="default"
          size="sm"
          className="absolute top-4 left-4 z-[1000] shadow-lg"
          onClick={() => setIsPanelOpen(true)}
          data-testid="button-open-panel"
        >
          <List className="h-4 w-4 mr-2" />
          Shipments ({stats.total})
        </Button>
      )}

      {/* Map Container - Full Screen */}
      <div className="flex-1 h-full">
        <MapContainer
          center={defaultCenter}
          zoom={5}
          className="h-full w-full"
          style={{ zIndex: 1 }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          
          {/* Fit bounds on initial load */}
          {markerPositions.length > 0 && (
            <FitBoundsToMarkers positions={markerPositions} />
          )}
          
          {/* Center on selected shipment */}
          {selectedPosition && (
            <CenterOnShipment position={selectedPosition} />
          )}
          
          {/* Truck Markers */}
          {filteredShipments.map((shipment) => {
            const position = getShipmentPosition(shipment);
            if (!position) return null;
            
            const isLive = !!telemetryData[shipment.truck?.registrationNumber || ""];
            const isSelected = selectedShipment?.id === shipment.id;
            
            return (
              <Marker
                key={shipment.id}
                position={position}
                icon={createTruckIcon(isLive, isSelected)}
                eventHandlers={{
                  click: () => handleSelectShipment(shipment),
                }}
              >
                <Popup>
                  <div className="min-w-[200px]">
                    <div className="font-bold mb-1">
                      LD-{shipment.load?.referenceNumber?.toString().padStart(3, "0") || "???"}
                    </div>
                    <div className="text-sm text-gray-600 mb-2">
                      {shipment.load?.pickupCity} → {shipment.load?.dropoffCity}
                    </div>
                    <div className="text-xs space-y-1">
                      <p><strong>Truck:</strong> {shipment.truck?.registrationNumber}</p>
                      <p><strong>Carrier:</strong> {shipment.carrier?.companyName}</p>
                      <p><strong>Status:</strong> {stageLabels[shipment.currentStage]}</p>
                      {isLive && telemetryData[shipment.truck?.registrationNumber || ""]?.speed && (
                        <p><strong>Speed:</strong> {telemetryData[shipment.truck?.registrationNumber || ""]?.speed?.toFixed(0)} km/h</p>
                      )}
                    </div>
                  </div>
                </Popup>
              </Marker>
            );
          })}
        </MapContainer>
      </div>

      {/* Selected Shipment Detail Panel */}
      {selectedShipment && (
        <div className="absolute top-0 right-0 h-full w-[420px] bg-background border-l shadow-lg z-[1000] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b">
            <div className="flex items-center gap-3">
              <Package className="h-5 w-5 text-primary" />
              <div>
                <h2 className="font-bold">
                  LD-{selectedShipment.load?.referenceNumber?.toString().padStart(3, "0") || "???"}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {selectedShipment.load?.pickupCity} → {selectedShipment.load?.dropoffCity}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSelectedShipment(null)}
              data-testid="button-close-detail"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Status Bar */}
          <div className="flex items-center gap-3 p-4 border-b bg-muted/30">
            <Badge className={stageBadgeColors[selectedShipment.currentStage] || ""}>
              {stageLabels[selectedShipment.currentStage] || selectedShipment.currentStage}
            </Badge>
            <Progress value={selectedShipment.progress} className="flex-1 h-2" />
            <span className="text-sm font-medium">{selectedShipment.progress}%</span>
          </div>

          {/* Tabs */}
          <Tabs defaultValue="timeline" className="flex-1 flex flex-col overflow-hidden">
            <TabsList className="grid w-full grid-cols-5 m-2 mx-4">
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              <TabsTrigger value="route">Route</TabsTrigger>
              <TabsTrigger value="shipper">Shipper</TabsTrigger>
              <TabsTrigger value="receiver">Receiver</TabsTrigger>
              <TabsTrigger value="carrier">Carrier</TabsTrigger>
            </TabsList>

            <ScrollArea className="flex-1">
              <TabsContent value="route" className="p-4 space-y-4 mt-0">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-green-600" />
                      Pickup Location
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="font-medium">{selectedShipment.load?.pickupCity}, {selectedShipment.load?.pickupState}</p>
                    <p className="text-sm text-muted-foreground">{selectedShipment.load?.pickupAddress}</p>
                    {selectedShipment.load?.pickupDate && (
                      <p className="text-sm mt-1">
                        <Clock className="h-3 w-3 inline mr-1" />
                        {format(new Date(selectedShipment.load.pickupDate), "PPp")}
                      </p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-red-600" />
                      Delivery Location
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="font-medium">{selectedShipment.load?.dropoffCity}, {selectedShipment.load?.dropoffState}</p>
                    <p className="text-sm text-muted-foreground">{selectedShipment.load?.dropoffAddress}</p>
                    {selectedShipment.eta && (
                      <p className="text-sm mt-1">
                        <Clock className="h-3 w-3 inline mr-1" />
                        ETA: {format(new Date(selectedShipment.eta), "PPp")}
                      </p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Current Location</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-2">
                      <Navigation className="h-4 w-4 text-primary" />
                      <span>{getLocationDisplay(selectedShipment)}</span>
                      {telemetryData[selectedShipment.truck?.registrationNumber || ""] && (
                        <Badge variant="outline" className="gap-1 ml-auto">
                          <Radio className="h-3 w-3 text-green-500 animate-pulse" />
                          Live
                        </Badge>
                      )}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Cargo Details</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    <p><span className="text-muted-foreground">Material:</span> {selectedShipment.load?.materialType || "Not specified"}</p>
                    <p><span className="text-muted-foreground">Weight:</span> {selectedShipment.load?.weight ? `${selectedShipment.load.weight} MT` : "Not specified"}</p>
                    <p><span className="text-muted-foreground">Truck Type:</span> {selectedShipment.load?.requiredTruckType?.replace(/_/g, " ") || "Not specified"}</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">OTP Verification Status</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="flex items-center gap-2">
                        {selectedShipment.otp.startVerified ? (
                          <CheckCircle className="h-4 w-4 text-green-600" />
                        ) : selectedShipment.otp.startRequested ? (
                          <AlertCircle className="h-4 w-4 text-yellow-600" />
                        ) : (
                          <Clock className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span>Pickup OTP</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {selectedShipment.otp.endVerified ? (
                          <CheckCircle className="h-4 w-4 text-green-600" />
                        ) : selectedShipment.otp.endRequested ? (
                          <AlertCircle className="h-4 w-4 text-yellow-600" />
                        ) : (
                          <Clock className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span>Delivery OTP</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="timeline" className="p-4 space-y-4 mt-0">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Driver Activity Timeline</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="relative">
                      {(selectedShipment.timeline || []).map((event, index) => {
                        const isLast = index === (selectedShipment.timeline?.length || 0) - 1;
                        return (
                          <div key={event.stage} className="flex gap-4 pb-4 last:pb-0">
                            <div className="relative flex flex-col items-center">
                              <div className={`flex h-8 w-8 items-center justify-center rounded-full ${
                                event.completed 
                                  ? "bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400" 
                                  : "bg-muted text-muted-foreground"
                              }`}>
                                {event.stage === "load_created" && <Package className="h-4 w-4" />}
                                {event.stage === "carrier_assigned" && <Truck className="h-4 w-4" />}
                                {event.stage === "reached_pickup" && <Building2 className="h-4 w-4" />}
                                {event.stage === "loaded" && <Package className="h-4 w-4" />}
                                {event.stage === "in_transit" && <Navigation className="h-4 w-4" />}
                                {event.stage === "arrived_at_drop" && <MapPin className="h-4 w-4" />}
                                {event.stage === "delivered" && <CheckCircle className="h-4 w-4" />}
                              </div>
                              {!isLast && (
                                <div className={`w-0.5 flex-1 mt-2 ${
                                  event.completed ? "bg-green-200 dark:bg-green-800" : "bg-border"
                                }`} />
                              )}
                            </div>
                            <div className="flex-1 pt-1">
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <p className={`font-medium text-sm ${!event.completed && "text-muted-foreground"}`}>
                                  {timelineStageLabels[event.stage] || event.stage}
                                </p>
                                {event.completed && (
                                  <CheckCircle className="h-4 w-4 text-green-500" />
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground">{event.location}</p>
                              {event.timestamp && (
                                <p className="text-xs text-muted-foreground mt-1">
                                  {format(new Date(event.timestamp), "MMM d 'at' h:mm a")}
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Documents</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {[
                      { key: "lr_consignment", label: "LR / Consignment Note" },
                      { key: "eway_bill", label: "E-way Bill" },
                      { key: "loading_photos", label: "Loading Photos" },
                      { key: "pod", label: "Proof of Delivery (POD)" },
                      { key: "invoice", label: "Invoice" },
                      { key: "other", label: "Other Document" },
                    ].map((docItem) => {
                      const doc = (selectedShipment.documents || []).find(d => 
                        d.documentType === docItem.key
                      );
                      const hasDocument = doc?.fileUrl;
                      return (
                        <div 
                          key={docItem.key} 
                          className="p-2 bg-muted/50 rounded-lg space-y-1.5"
                          data-testid={`admin-document-${docItem.key}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                              <span className="text-sm truncate">{docItem.label}</span>
                            </div>
                            {doc?.isVerified ? (
                              <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 shrink-0">
                                <CheckCircle className="h-3 w-3 mr-1" />
                                Approved
                              </Badge>
                            ) : hasDocument ? (
                              <Badge variant="outline" className="text-yellow-600 dark:text-yellow-400 border-yellow-300 dark:border-yellow-700 shrink-0">
                                <Clock className="h-3 w-3 mr-1" />
                                Pending
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-muted-foreground shrink-0">
                                Not Uploaded
                              </Badge>
                            )}
                          </div>
                          {hasDocument && !doc?.isVerified && (
                            <div className="flex items-center gap-2 pl-6">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                onClick={() => {
                                  if (doc.fileUrl) {
                                    const url = doc.fileUrl.startsWith('http') || doc.fileUrl.startsWith('data:') || doc.fileUrl.startsWith('/objects/') 
                                      ? doc.fileUrl 
                                      : `/objects/${doc.fileUrl}`;
                                    window.open(url, '_blank');
                                  }
                                }}
                                data-testid={`button-view-doc-${docItem.key}`}
                              >
                                <Eye className="h-3 w-3 mr-1" />
                                View
                              </Button>
                              <Button
                                size="sm"
                                className="h-7 text-xs bg-green-600 text-white"
                                onClick={() => {
                                  verifyDocumentMutation.mutate({ documentId: doc.id, isVerified: true });
                                }}
                                disabled={verifyDocumentMutation.isPending}
                                data-testid={`button-approve-doc-${docItem.key}`}
                              >
                                <CheckCircle className="h-3 w-3 mr-1" />
                                Approve
                              </Button>
                            </div>
                          )}
                          {doc?.isVerified && (
                            <div className="pl-6">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                onClick={() => {
                                  if (doc.fileUrl) {
                                    const url = doc.fileUrl.startsWith('http') || doc.fileUrl.startsWith('data:') || doc.fileUrl.startsWith('/objects/') 
                                      ? doc.fileUrl 
                                      : `/objects/${doc.fileUrl}`;
                                    window.open(url, '_blank');
                                  }
                                }}
                                data-testid={`button-view-doc-${docItem.key}`}
                              >
                                <Eye className="h-3 w-3 mr-1" />
                                View Document
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>

                <Card data-testid="finance-review-card">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <FileText className="h-4 w-4" /> Document Review
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {selectedShipment.financeReview && (
                      <div className="text-sm space-y-1 p-2 bg-muted/50 rounded-lg">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-muted-foreground">Review Status:</span>
                          {(() => {
                            const config = reviewStatusConfig[selectedShipment.financeReview.status] || reviewStatusConfig.pending;
                            const Icon = config.icon;
                            return (
                              <Badge className={`text-xs ${config.color}`}>
                                <Icon className="h-3 w-3 mr-1" />
                                {config.label}
                              </Badge>
                            );
                          })()}
                        </div>
                        {selectedShipment.financeReview.comment && (
                          <p><span className="text-muted-foreground">Comment:</span> {selectedShipment.financeReview.comment}</p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          By {selectedShipment.financeReview.reviewerName}
                          {selectedShipment.financeReview.reviewedAt && (
                            <> on {format(new Date(selectedShipment.financeReview.reviewedAt), "MMM d, yyyy 'at' h:mm a")}</>
                          )}
                        </p>
                      </div>
                    )}

                    <Textarea
                      placeholder="Add a comment for this finance decision..."
                      value={reviewComment}
                      onChange={(e) => setReviewComment(e.target.value)}
                      className="text-sm"
                      data-testid="input-review-comment"
                    />

                    <div className="flex gap-2 flex-wrap">
                      <Button
                        size="sm"
                        className="bg-green-600 text-white"
                        onClick={() => handleReview("approved")}
                        disabled={reviewMutation.isPending}
                        data-testid="button-approve"
                      >
                        <CheckCircle className="h-3.5 w-3.5 mr-1" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        className="bg-orange-500 text-white"
                        onClick={() => handleReview("on_hold")}
                        disabled={reviewMutation.isPending}
                        data-testid="button-hold"
                      >
                        <PauseCircle className="h-3.5 w-3.5 mr-1" />
                        Hold
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleReview("rejected")}
                        disabled={reviewMutation.isPending}
                        data-testid="button-reject"
                      >
                        <XCircle className="h-3.5 w-3.5 mr-1" />
                        Reject
                      </Button>
                    </div>

                    {selectedShipment.financeReview?.status === "approved" && (
                      <div className="pt-2 border-t space-y-2">
                        <p className="text-sm font-medium flex items-center gap-1">
                          <DollarSign className="h-4 w-4" /> Payment Status
                        </p>
                        <div className="flex gap-2 flex-wrap">
                          <Button
                            size="sm"
                            variant={selectedShipment.financeReview.paymentStatus === "processing" ? "default" : "outline"}
                            onClick={() => paymentMutation.mutate({ reviewId: selectedShipment.financeReview!.id, paymentStatus: "processing" })}
                            disabled={paymentMutation.isPending}
                            data-testid="button-payment-processing"
                          >
                            <Clock className="h-3.5 w-3.5 mr-1" />
                            Processing
                          </Button>
                          <Button
                            size="sm"
                            variant={selectedShipment.financeReview.paymentStatus === "released" ? "default" : "outline"}
                            className={selectedShipment.financeReview.paymentStatus === "released" ? "bg-green-600 text-white" : ""}
                            onClick={() => paymentMutation.mutate({ reviewId: selectedShipment.financeReview!.id, paymentStatus: "released" })}
                            disabled={paymentMutation.isPending}
                            data-testid="button-payment-released"
                          >
                            <CheckCircle className="h-3.5 w-3.5 mr-1" />
                            Released
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="shipper" className="p-4 space-y-4 mt-0">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Building2 className="h-4 w-4" />
                      Company Details
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p className="font-medium text-base">{selectedShipment.shipper?.companyName || "N/A"}</p>
                    <p><span className="text-muted-foreground">Contact:</span> {selectedShipment.shipper?.contactName || "N/A"}</p>
                    {selectedShipment.shipper?.phone && (
                      <p className="flex items-center gap-2">
                        <Phone className="h-3 w-3" />
                        {selectedShipment.shipper.phone}
                      </p>
                    )}
                    {selectedShipment.shipper?.email && (
                      <p className="flex items-center gap-2">
                        <Mail className="h-3 w-3" />
                        {selectedShipment.shipper.email}
                      </p>
                    )}
                    {selectedShipment.shipper?.address && (
                      <p className="flex items-start gap-2">
                        <MapPin className="h-3 w-3 mt-0.5" />
                        {selectedShipment.shipper.address}
                      </p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="receiver" className="p-4 space-y-4 mt-0">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <User className="h-4 w-4" />
                      Receiver Details
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p className="font-medium text-base">{selectedShipment.receiver?.name || selectedShipment.receiver?.businessName || "N/A"}</p>
                    {selectedShipment.receiver?.businessName && selectedShipment.receiver?.name && (
                      <p><span className="text-muted-foreground">Business:</span> {selectedShipment.receiver.businessName}</p>
                    )}
                    {selectedShipment.receiver?.phone && (
                      <p className="flex items-center gap-2">
                        <Phone className="h-3 w-3" />
                        {selectedShipment.receiver.phone}
                      </p>
                    )}
                    {selectedShipment.receiver?.email && (
                      <p className="flex items-center gap-2">
                        <Mail className="h-3 w-3" />
                        {selectedShipment.receiver.email}
                      </p>
                    )}
                    {(selectedShipment.receiver?.address || selectedShipment.receiver?.city) && (
                      <p className="flex items-start gap-2">
                        <MapPin className="h-3 w-3 mt-0.5" />
                        {[selectedShipment.receiver?.address, selectedShipment.receiver?.city].filter(Boolean).join(", ")}
                      </p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="carrier" className="p-4 space-y-4 mt-0">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Building2 className="h-4 w-4" />
                      Carrier Details
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p className="font-medium text-base">{selectedShipment.carrier?.companyName || "N/A"}</p>
                    <p>
                      <span className="text-muted-foreground">Type:</span>{" "}
                      <Badge variant="outline" className="ml-1">
                        {selectedShipment.carrier?.carrierType === "solo" ? "Solo Operator" : "Fleet/Company"}
                      </Badge>
                    </p>
                    {selectedShipment.carrier?.phone && (
                      <p className="flex items-center gap-2">
                        <Phone className="h-3 w-3" />
                        {selectedShipment.carrier.phone}
                      </p>
                    )}
                  </CardContent>
                </Card>

                {selectedShipment.driver && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <User className="h-4 w-4" />
                        Driver Details
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <p className="font-medium">{selectedShipment.driver.name}</p>
                      {selectedShipment.driver.phone && (
                        <p className="flex items-center gap-2">
                          <Phone className="h-3 w-3" />
                          {selectedShipment.driver.phone}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                )}

                {selectedShipment.truck && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Truck className="h-4 w-4" />
                        Truck Details
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1 text-sm">
                      <p><span className="text-muted-foreground">Registration:</span> {selectedShipment.truck.registrationNumber}</p>
                      <p><span className="text-muted-foreground">Type:</span> {selectedShipment.truck.truckType?.replace(/_/g, " ") || "N/A"}</p>
                      <p><span className="text-muted-foreground">Capacity:</span> {selectedShipment.truck.capacity} MT</p>
                    </CardContent>
                  </Card>
                )}
              </TabsContent>
            </ScrollArea>
          </Tabs>
        </div>
      )}
    </div>
  );
}
