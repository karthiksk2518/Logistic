import { useState, useMemo, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useTranslation } from "react-i18next";
import { 
  Search, MapPin, LayoutGrid, List, Package, Star, 
  Truck, TrendingUp, ArrowRight, Building2, Calendar,
  Target, Timer, Sparkles, ShieldCheck, Lock, Unlock, Loader2, CheckCircle
} from "lucide-react";
import { connectMarketplace, onMarketplaceEvent, disconnectMarketplace } from "@/lib/marketplace-socket";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/empty-state";
import { StatCard } from "@/components/stat-card";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";

interface CarrierLoad {
  id: string;
  origin: string;
  destination: string;
  // Full address details
  pickupAddress?: string | null;
  pickupLocality?: string | null;
  pickupLandmark?: string | null;
  pickupCity?: string | null;
  dropoffAddress?: string | null;
  dropoffLocality?: string | null;
  dropoffLandmark?: string | null;
  dropoffBusinessName?: string | null;
  dropoffCity?: string | null;
  loadType: string | null;
  weight: string | null;
  estimatedDistance: number | null;
  adminFinalPrice: string | null;
  finalPrice: string | null;
  allowCounterBids: boolean | null;
  shipperName: string | null;
  shipperId?: string | null;
  bidCount: number;
  myBid: any | null;
  postedByAdmin: boolean;
  priceFixed: boolean;
  createdAt: string;
  isSimulated?: boolean;
  pickupDate?: string | null;
  deliveryDate?: string | null;
  shipperLoadNumber?: number | null;
  adminReferenceNumber?: number | null;
  carrierAdvancePercent?: number | null;
  cargoDescription?: string | null;
  postedAt?: string | null;
}

interface ShipperRatingData {
  averageRating: number | null;
  totalRatings: number;
}

// Helper to get carrier display price (finalPrice = carrier payout price)
function getCarrierPrice(load: CarrierLoad): number {
  return parseFloat(load.finalPrice || load.adminFinalPrice || "0");
}

// Format load ID for display - shows LD-1001 (admin ref) or LD-023 (shipper seq)
function formatLoadId(load: { shipperLoadNumber?: number | null; adminReferenceNumber?: number | null; id: string }): string {
  if (load.adminReferenceNumber) {
    return `LD-${String(load.adminReferenceNumber).padStart(3, '0')}`;
  }
  if (load.shipperLoadNumber) {
    return `LD-${String(load.shipperLoadNumber).padStart(3, '0')}`;
  }
  return load.id.slice(0, 8);
}

// Helper function to estimate distance between cities
function estimateDistanceFromCities(pickup: string, dropoff: string): number {
  const distanceMap: Record<string, number> = {
    "mumbai_delhi": 1400, "delhi_mumbai": 1400,
    "bangalore_chennai": 350, "chennai_bangalore": 350,
    "pune_hyderabad": 560, "hyderabad_pune": 560,
    "kolkata_guwahati": 980, "guwahati_kolkata": 980,
    "ahmedabad_jaipur": 680, "jaipur_ahmedabad": 680,
    "ludhiana_delhi": 310, "delhi_ludhiana": 310,
    "coimbatore_kochi": 190, "kochi_coimbatore": 190,
    "nagpur_bhopal": 350, "bhopal_nagpur": 350,
  };
  
  const normalizeCity = (city: string) => 
    (city || "").toLowerCase().split(",")[0].trim().replace(/\s+/g, "");
  
  const key1 = `${normalizeCity(pickup)}_${normalizeCity(dropoff)}`;
  const key2 = `${normalizeCity(dropoff)}_${normalizeCity(pickup)}`;
  
  return distanceMap[key1] || distanceMap[key2] || Math.floor(Math.random() * 800) + 200;
}

const simulatedLoads: CarrierLoad[] = [
  {
    id: "DEMO-001",
    origin: "Mumbai, Maharashtra",
    destination: "Delhi, NCR",
    loadType: "32 ft MXL",
    weight: "18",
    estimatedDistance: 1420,
    adminFinalPrice: "125000",
    finalPrice: "112500",
    allowCounterBids: true,
    shipperName: "Reliance Industries",
    bidCount: 3,
    myBid: null,
    postedByAdmin: true,
    priceFixed: false,
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    isSimulated: true,
  },
  {
    id: "DEMO-002",
    origin: "Bengaluru, Karnataka",
    destination: "Chennai, Tamil Nadu",
    loadType: "Container 20ft",
    weight: "12",
    estimatedDistance: 350,
    adminFinalPrice: "45000",
    finalPrice: "40500",
    allowCounterBids: false,
    shipperName: "Tata Motors",
    bidCount: 5,
    myBid: null,
    postedByAdmin: true,
    priceFixed: true,
    createdAt: new Date(Date.now() - 7200000).toISOString(),
    isSimulated: true,
  },
  {
    id: "DEMO-003",
    origin: "Ahmedabad, Gujarat",
    destination: "Jaipur, Rajasthan",
    loadType: "Taurus 21T",
    weight: "22",
    estimatedDistance: 680,
    adminFinalPrice: "78000",
    finalPrice: "70200",
    allowCounterBids: true,
    shipperName: "Adani Group",
    bidCount: 2,
    myBid: null,
    postedByAdmin: true,
    priceFixed: false,
    createdAt: new Date(Date.now() - 1800000).toISOString(),
    isSimulated: true,
  },
  {
    id: "DEMO-004",
    origin: "Kolkata, West Bengal",
    destination: "Guwahati, Assam",
    loadType: "32 ft SXL",
    weight: "20",
    estimatedDistance: 980,
    adminFinalPrice: "92000",
    finalPrice: "82800",
    allowCounterBids: false,
    shipperName: "ITC Limited",
    bidCount: 4,
    myBid: null,
    postedByAdmin: true,
    priceFixed: true,
    createdAt: new Date(Date.now() - 5400000).toISOString(),
    isSimulated: true,
  },
  {
    id: "DEMO-005",
    origin: "Pune, Maharashtra",
    destination: "Hyderabad, Telangana",
    loadType: "28 ft MXL",
    weight: "15",
    estimatedDistance: 560,
    adminFinalPrice: "62000",
    finalPrice: "55800",
    allowCounterBids: true,
    shipperName: "Mahindra Logistics",
    bidCount: 6,
    myBid: null,
    postedByAdmin: true,
    priceFixed: false,
    createdAt: new Date(Date.now() - 900000).toISOString(),
    isSimulated: true,
  },
  {
    id: "DEMO-006",
    origin: "Ludhiana, Punjab",
    destination: "Delhi, NCR",
    loadType: "Open Truck",
    weight: "25",
    estimatedDistance: 310,
    adminFinalPrice: "38000",
    finalPrice: "34200",
    allowCounterBids: false,
    shipperName: "Hero MotoCorp",
    bidCount: 8,
    myBid: null,
    postedByAdmin: true,
    priceFixed: true,
    createdAt: new Date(Date.now() - 10800000).toISOString(),
    isSimulated: true,
  },
  {
    id: "DEMO-007",
    origin: "Coimbatore, Tamil Nadu",
    destination: "Kochi, Kerala",
    loadType: "Container 40ft",
    weight: "28",
    estimatedDistance: 190,
    adminFinalPrice: "32000",
    finalPrice: "28800",
    allowCounterBids: true,
    shipperName: "Asian Paints",
    bidCount: 1,
    myBid: null,
    postedByAdmin: true,
    priceFixed: false,
    createdAt: new Date(Date.now() - 14400000).toISOString(),
    isSimulated: true,
  },
  {
    id: "DEMO-008",
    origin: "Nagpur, Maharashtra",
    destination: "Bhopal, Madhya Pradesh",
    loadType: "Trailer 20ft",
    weight: "16",
    estimatedDistance: 350,
    adminFinalPrice: "48000",
    finalPrice: "43200",
    allowCounterBids: false,
    shipperName: "Ultratech Cement",
    bidCount: 3,
    myBid: null,
    postedByAdmin: true,
    priceFixed: true,
    createdAt: new Date(Date.now() - 21600000).toISOString(),
    isSimulated: true,
  },
];

function formatCurrency(amount: number): string {
  return `Rs. ${amount.toLocaleString("en-IN")}`;
}

function ShipperRatingBadge({ shipperId }: { shipperId: string | null | undefined }) {
  const { data: ratingData, isError } = useQuery<ShipperRatingData>({
    queryKey: [`/api/shipper/${shipperId}/rating`],
    enabled: !!shipperId,
    staleTime: 5 * 60 * 1000,
  });

  if (!shipperId || isError || !ratingData || ratingData.totalRatings === 0) {
    return null;
  }

  return (
    <span className="inline-flex items-center gap-0.5 text-xs" data-testid={`shipper-rating-${shipperId}`}>
      <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
      <span className="font-medium">{ratingData.averageRating}</span>
      <span className="text-muted-foreground">({ratingData.totalRatings})</span>
    </span>
  );
}

function getMatchScoreBadge(score: number) {
  if (score >= 90) return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400";
  if (score >= 75) return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
  return "bg-muted text-muted-foreground";
}

interface RecommendedLoadData {
  loadId: string;
  loadNumber: string;
  pickupCity: string;
  dropoffCity: string;
  weight: string;
  materialType: string | null;
  requiredTruckType: string | null;
  pickupDate: string | null;
  price: number | null;
  score: number;
  matchReasons: string[];
  truckTypeMatch: boolean;
  capacityMatch: boolean;
  routeMatch: boolean;
  commodityMatch: boolean;
  shipperMatch: boolean;
}

function calculateMatchScore(load: CarrierLoad, recommendations?: RecommendedLoadData[]): number {
  if (recommendations && recommendations.length > 0) {
    const rec = recommendations.find(r => r.loadId === load.id);
    if (rec) return rec.score;
  }
  return 0;
}

export default function CarrierLoadsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user, carrierType } = useAuth();
  const isEnterprise = carrierType === "enterprise";
  const searchString = useSearch();
  const highlightLoadId = new URLSearchParams(searchString).get("highlight");
  
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [distanceFilter, setDistanceFilter] = useState("all");
  const [loadTypeFilter, setLoadTypeFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [bidDialogOpen, setBidDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<"accept" | "bid">("accept");
  const [selectedLoad, setSelectedLoad] = useState<CarrierLoad | null>(null);
  const [bidAmount, setBidAmount] = useState("");
  const [simulatedLoadStates, setSimulatedLoadStates] = useState<Record<string, { myBid?: { amount: string }, status?: string }>>({});
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [detailLoad, setDetailLoad] = useState<CarrierLoad | null>(null);
  const [selectedTruckId, setSelectedTruckId] = useState<string>("");
  const [selectedDriverId, setSelectedDriverId] = useState<string>("");

  // Fetch trucks and drivers for enterprise carriers (with availability info)
  const { data: trucks = [], refetch: refetchTrucks } = useQuery<{ id: string; licensePlate: string; truckType: string; make?: string; model?: string; isAvailable?: boolean; unavailableReason?: string | null }[]>({
    queryKey: ["/api/trucks"],
    enabled: isEnterprise,
    staleTime: 0, // Always refetch for fresh availability data
  });

  const { data: drivers = [], refetch: refetchDrivers } = useQuery<{ id: string; name: string; phone?: string; licenseNumber?: string; isAvailable?: boolean; unavailableReason?: string | null }[]>({
    queryKey: ["/api/drivers"],
    enabled: isEnterprise,
    staleTime: 0, // Always refetch for fresh availability data
  });
  
  // Refetch trucks and drivers when bid dialog opens
  useEffect(() => {
    if (bidDialogOpen && isEnterprise) {
      refetchTrucks();
      refetchDrivers();
    }
  }, [bidDialogOpen, isEnterprise, refetchTrucks, refetchDrivers]);
  
  // Filter to only show available trucks and drivers in bid dialog
  const availableTrucks = trucks.filter(t => t.isAvailable !== false);
  const availableDrivers = drivers.filter(d => d.isAvailable !== false);

  useEffect(() => {
    if (user?.id && user?.role === "carrier") {
      connectMarketplace("carrier", user.id);
      
      const unsubscribe = onMarketplaceEvent("load_posted", (loadData) => {
        toast({
          title: t("carrier.newLoadAvailable"),
          description: `${loadData.pickupCity} ${t("common.to")} ${loadData.dropoffCity} - Rs. ${parseFloat(loadData.finalPrice || loadData.adminFinalPrice || "0").toLocaleString("en-IN")}`,
        });
      });

      return () => {
        unsubscribe();
        disconnectMarketplace();
      };
    }
  }, [user?.id, user?.role, toast]);

  useEffect(() => {
    if (highlightLoadId) {
      setHighlightedId(highlightLoadId);
      setTimeout(() => {
        const element = document.querySelector(`[data-testid="load-card-${highlightLoadId}"]`) 
          || document.querySelector(`[data-testid="load-row-${highlightLoadId}"]`);
        if (element) {
          element.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 500);
      setTimeout(() => setHighlightedId(null), 5000);
    }
  }, [highlightLoadId]);

  // Raw API response type (before transformation)
  interface ApiLoad {
    id: string;
    pickupCity: string;
    dropoffCity: string;
    // Full address details
    pickupAddress: string | null;
    pickupLocality: string | null;
    pickupLandmark: string | null;
    dropoffAddress: string | null;
    dropoffLocality: string | null;
    dropoffLandmark: string | null;
    dropoffBusinessName: string | null;
    requiredTruckType: string | null;
    weight: string | null;
    distance: number | null;
    adminFinalPrice: string | null;
    finalPrice: string | null;
    allowCounterBids: boolean | null;
    shipperName: string | null;
    shipperId: string | null;
    bidCount: number;
    myBid: any | null;
    postedByAdmin: boolean;
    priceFixed: boolean;
    createdAt: string;
    postedAt: string | null;
    pickupDate: string | null;
    deliveryDate: string | null;
    carrierAdvancePercent: number | null;
    cargoDescription: string | null;
    goodsToBeCarried: string | null;
    shipperLoadNumber: number | null;
    adminReferenceNumber: number | null;
  }

  const { data: rawApiLoads = [], isLoading, error } = useQuery<ApiLoad[]>({
    queryKey: ['/api/carrier/loads'],
  });

  // Fetch AI-powered load recommendations
  const { data: recommendations = [] } = useQuery<RecommendedLoadData[]>({
    queryKey: ['/api/carrier/recommended-loads'],
    staleTime: 60000, // Cache for 1 minute
  });

  // Create a lookup map for recommendation data
  const recommendationMap = useMemo(() => {
    const map = new Map<string, RecommendedLoadData>();
    recommendations.forEach(rec => map.set(rec.loadId, rec));
    return map;
  }, [recommendations]);

  // Transform API data to match CarrierLoad interface
  const apiLoads: CarrierLoad[] = useMemo(() => {
    return rawApiLoads.map(load => ({
      id: load.id,
      origin: load.pickupCity || "Unknown",
      destination: load.dropoffCity || "Unknown",
      // Full address details
      pickupAddress: load.pickupAddress,
      pickupLocality: load.pickupLocality,
      pickupLandmark: load.pickupLandmark,
      pickupCity: load.pickupCity,
      dropoffAddress: load.dropoffAddress,
      dropoffLocality: load.dropoffLocality,
      dropoffLandmark: load.dropoffLandmark,
      dropoffBusinessName: load.dropoffBusinessName,
      dropoffCity: load.dropoffCity,
      loadType: load.requiredTruckType,
      weight: load.weight,
      estimatedDistance: load.distance || estimateDistanceFromCities(load.pickupCity, load.dropoffCity),
      adminFinalPrice: load.adminFinalPrice,
      finalPrice: load.finalPrice,
      allowCounterBids: load.allowCounterBids,
      shipperName: load.shipperName,
      shipperId: load.shipperId,
      bidCount: load.bidCount || 0,
      myBid: load.myBid,
      postedByAdmin: load.postedByAdmin ?? true,
      priceFixed: load.priceFixed ?? false,
      createdAt: load.postedAt || load.createdAt,
      isSimulated: false,
      pickupDate: load.pickupDate,
      deliveryDate: load.deliveryDate,
      carrierAdvancePercent: load.carrierAdvancePercent,
      cargoDescription: load.goodsToBeCarried || load.cargoDescription,
      postedAt: load.postedAt,
      shipperLoadNumber: load.shipperLoadNumber,
      adminReferenceNumber: load.adminReferenceNumber,
    }));
  }, [rawApiLoads]);

  const loads = useMemo(() => {
    return [...apiLoads, ...simulatedLoads];
  }, [apiLoads]);

  const bidMutation = useMutation({
    mutationFn: async (data: { load_id: string; amount: number; bid_type: string; truck_id?: string; driver_id?: string }) => {
      return apiRequest('POST', '/api/bids/submit', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/carrier/loads'] });
      // Reset truck/driver selection after successful bid
      setSelectedTruckId("");
      setSelectedDriverId("");
    },
  });

  // Direct accept mutation for fixed-price loads - creates invoice and shipment immediately
  const acceptDirectMutation = useMutation({
    mutationFn: async (data: { load_id: string; truck_id?: string; driver_id?: string }) => {
      return apiRequest('POST', `/api/loads/${data.load_id}/accept-direct`, {
        truck_id: data.truck_id,
        driver_id: data.driver_id,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/carrier/loads'] });
      queryClient.invalidateQueries({ queryKey: ['/api/carrier/shipments'] });
      setSelectedTruckId("");
      setSelectedDriverId("");
    },
  });

  const loadsWithScores = useMemo(() => {
    return loads.map(load => {
      const simState = load.isSimulated ? simulatedLoadStates[load.id] : undefined;
      const rec = recommendationMap.get(load.id);
      return {
        ...load,
        matchScore: rec ? rec.score : calculateMatchScore(load, recommendations),
        matchReasons: rec?.matchReasons || [],
        truckTypeMatch: rec?.truckTypeMatch || false,
        capacityMatch: rec?.capacityMatch || false,
        routeMatch: rec?.routeMatch || false,
        commodityMatch: rec?.commodityMatch || false,
        shipperMatch: rec?.shipperMatch || false,
        myBid: simState?.myBid || load.myBid,
      };
    });
  }, [loads, simulatedLoadStates, recommendationMap, recommendations]);

  const filteredAndSortedLoads = useMemo(() => {
    const query = searchQuery.toLowerCase();
    let filtered = loadsWithScores.filter((load) => {
      const matchesSearch = !query ||
        (load.origin ?? "").toLowerCase().includes(query) ||
        (load.destination ?? "").toLowerCase().includes(query) ||
        (load.shipperName ?? "").toLowerCase().includes(query) ||
        (load.id ?? "").toLowerCase().includes(query);
      
      const distance = load.estimatedDistance || 0;
      const matchesDistance =
        distanceFilter === "all" ||
        (distanceFilter === "short" && distance < 500) ||
        (distanceFilter === "medium" && distance >= 500 && distance < 1000) ||
        (distanceFilter === "long" && distance >= 1000);
      
      const matchesLoadType = loadTypeFilter === "all" || load.loadType === loadTypeFilter;
      return matchesSearch && matchesDistance && matchesLoadType;
    });

    switch (sortBy) {
      case "match":
        filtered.sort((a, b) => b.matchScore - a.matchScore);
        break;
      case "rate":
        filtered.sort((a, b) => getCarrierPrice(b) - getCarrierPrice(a));
        break;
      case "distance":
        filtered.sort((a, b) => (a.estimatedDistance || 0) - (b.estimatedDistance || 0));
        break;
      case "newest":
        filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        break;
    }

    return filtered;
  }, [loadsWithScores, searchQuery, distanceFilter, loadTypeFilter, sortBy]);

  const loadTypes = useMemo(() => {
    const types = new Set(loads.map(l => l.loadType).filter(Boolean));
    return Array.from(types) as string[];
  }, [loads]);

  const stats = useMemo(() => {
    const total = loads.length;
    const highMatch = loadsWithScores.filter(l => l.matchScore >= 50).length;
    const avgRate = loads.length > 0
      ? Math.round(loads.reduce((sum, l) => sum + getCarrierPrice(l), 0) / loads.length)
      : 0;
    const fixedPriceLoads = loads.filter(l => l.priceFixed).length;
    
    return { total, highMatch, avgRate, fixedPriceLoads };
  }, [loads, loadsWithScores]);

  const handleBid = (load: CarrierLoad & { matchScore: number }) => {
    setSelectedLoad(load);
    const price = getCarrierPrice(load);
    setBidAmount(price.toString());
    setSelectedTruckId("");
    setSelectedDriverId("");
    setBidDialogOpen(true);
  };

  const handleSimulatedAccept = (load: CarrierLoad, price: number) => {
    setSimulatedLoadStates(prev => ({
      ...prev,
      [load.id]: {
        myBid: { amount: price.toString() },
        status: 'awarded'
      }
    }));
    toast({
      title: t("carrier.loadAccepted"),
      description: t("carrier.loadAcceptedDesc", { price: formatCurrency(price) }),
    });
    setBidDialogOpen(false);
    setBidAmount("");
    setSelectedLoad(null);
  };

  const handleSimulatedBid = (load: CarrierLoad, amount: number, isCounter: boolean) => {
    setSimulatedLoadStates(prev => ({
      ...prev,
      [load.id]: {
        myBid: { amount: amount.toString() },
        status: isCounter ? 'counter_received' : 'bidding'
      }
    }));
    toast({
      title: isCounter ? t("bids.counterSubmitted") : t("bids.bidPlacedSuccessfully"),
      description: isCounter
        ? t("bids.counterSubmittedDesc", { amount: formatCurrency(amount) })
        : t("bids.bidSubmittedDesc", { amount: formatCurrency(amount) }),
    });
    setBidDialogOpen(false);
    setBidAmount("");
    setSelectedLoad(null);
  };

  const handleAccept = async () => {
    if (!selectedLoad) return;
    const price = getCarrierPrice(selectedLoad);
    
    if (selectedLoad.isSimulated) {
      handleSimulatedAccept(selectedLoad, price);
      return;
    }
    
    try {
      // Use direct accept for accepting at listed price - creates invoice and shipment immediately
      await acceptDirectMutation.mutateAsync({
        load_id: selectedLoad.id,
        ...(isEnterprise && selectedTruckId && { truck_id: selectedTruckId }),
        ...(isEnterprise && selectedDriverId && { driver_id: selectedDriverId }),
      });
      
      toast({
        title: t("carrier.loadAccepted"),
        description: `Load accepted at ${formatCurrency(price)}. Shipment created and ready for pickup.`,
      });
      setBidDialogOpen(false);
      setBidAmount("");
      setSelectedLoad(null);
    } catch (err: any) {
      toast({
        title: t("carrier.failedToAccept"),
        description: err.message || t("carrier.couldNotAcceptLoad"),
        variant: "destructive",
      });
    }
  };

  // Direct accept from card button - for solo carriers or when no truck/driver selection needed
  const handleDirectAccept = async (load: CarrierLoad & { matchScore: number }) => {
    const price = getCarrierPrice(load);
    
    if (load.isSimulated) {
      handleSimulatedAccept(load, price);
      return;
    }
    
    // For enterprise carriers, open dialog to select truck/driver
    if (isEnterprise) {
      setSelectedLoad(load);
      setBidAmount(price.toString());
      setSelectedTruckId("");
      setSelectedDriverId("");
      setDialogMode("accept");
      setBidDialogOpen(true);
      return;
    }
    
    try {
      await acceptDirectMutation.mutateAsync({
        load_id: load.id,
      });
      
      toast({
        title: t("carrier.loadAccepted"),
        description: `Load accepted at ${formatCurrency(price)}. Shipment created and ready for pickup.`,
      });
    } catch (err: any) {
      toast({
        title: t("carrier.failedToAccept"),
        description: err.message || t("carrier.couldNotAcceptLoad"),
        variant: "destructive",
      });
    }
  };

  // Open bid dialog for placing a counter bid
  const handlePlaceBid = (load: CarrierLoad & { matchScore: number }) => {
    setSelectedLoad(load);
    const price = getCarrierPrice(load);
    setBidAmount(price.toString());
    setSelectedTruckId("");
    setSelectedDriverId("");
    setDialogMode("bid");
    setBidDialogOpen(true);
  };

  const submitBid = async () => {
    if (!bidAmount || !selectedLoad) return;
    
    const amount = parseInt(bidAmount);
    const carrierPrice = getCarrierPrice(selectedLoad);
    const isCounterBid = !selectedLoad.priceFixed && amount !== carrierPrice;
    
    if (selectedLoad.isSimulated) {
      handleSimulatedBid(selectedLoad, amount, isCounterBid);
      return;
    }
    
    try {
      await bidMutation.mutateAsync({
        load_id: selectedLoad.id,
        amount,
        bid_type: isCounterBid ? 'counter' : 'carrier_bid',
        ...(isEnterprise && selectedTruckId && { truck_id: selectedTruckId }),
        ...(isEnterprise && selectedDriverId && { driver_id: selectedDriverId }),
      });
      
      toast({
        title: isCounterBid ? t("bids.counterSubmitted") : t("bids.bidPlacedSuccessfully"),
        description: isCounterBid
          ? t("bids.counterSubmittedDesc", { amount: formatCurrency(amount) })
          : t("bids.bidSubmittedDesc", { amount: formatCurrency(amount) }),
      });
      setBidDialogOpen(false);
      setBidAmount("");
      setSelectedLoad(null);
    } catch (err: any) {
      toast({
        title: t("bids.failedToSubmitBid"),
        description: err.message || t("bids.couldNotSubmitBid"),
        variant: "destructive",
      });
    }
  };

  const topRecommendations = filteredAndSortedLoads
    .filter(l => l.matchScore >= 50)
    .slice(0, 3);

  if (isLoading) {
    return (
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">{t("carrier.smartLoadMatching")}</h1>
            <p className="text-muted-foreground">{t("common.loading")}</p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map(i => (
            <Card key={i}>
              <CardContent className="pt-4">
                <Skeleton className="h-20 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <Card key={i}>
              <CardContent className="pt-4">
                <Skeleton className="h-40 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <EmptyState
          icon={Package}
          title={t("carrier.failedToLoadLoads")}
          description={t("carrier.errorLoadingLoads")}
        />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-loads-title">{t("carrier.smartLoadMatching")}</h1>
          <p className="text-muted-foreground">{t("carrier.findAndBidLoads", { count: loads.length })}</p>
        </div>
      </div>
      
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title={t("carrier.availableLoads")}
          value={stats.total}
          icon={Package}
          subtitle={t("carrier.currentlyPosted")}
          testId="stat-total-loads"
        />
        <StatCard
          title={t("carrier.highMatch")}
          value={stats.highMatch}
          icon={Target}
          subtitle="50+ match score"
          testId="stat-high-match"
        />
        <StatCard
          title={t("carrier.avgRate")}
          value={formatCurrency(stats.avgRate)}
          icon={TrendingUp}
          subtitle={t("carrier.perLoad")}
          testId="stat-avg-rate"
        />
        <StatCard
          title={t("carrier.fixedPrice")}
          value={stats.fixedPriceLoads}
          icon={Lock}
          subtitle={t("carrier.acceptInstantly")}
          testId="stat-fixed"
        />
      </div>

      {topRecommendations.length > 0 && (
        <Card className="border-primary/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              {t("carrier.recommendedForFleet")}
            </CardTitle>
            <CardDescription>Matched based on your truck, route history, and experience</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-3">
              {topRecommendations.map((load) => (
                <Card 
                  key={load.id} 
                  className="hover-elevate cursor-pointer" 
                  data-testid={`rec-load-${load.id}`}
                  onClick={() => {
                    setDetailLoad(load);
                    setDetailDialogOpen(true);
                  }}
                >
                  <CardContent className="pt-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge className={`${getMatchScoreBadge(load.matchScore)} no-default-hover-elevate no-default-active-elevate`}>
                          <Target className="h-3 w-3 mr-1" />
                          {load.matchScore} pts
                        </Badge>
                        {load.postedByAdmin && !load.isSimulated && (
                          <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 no-default-hover-elevate no-default-active-elevate">
                            <ShieldCheck className="h-3 w-3 mr-1" />
                            Admin
                          </Badge>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">{formatLoadId(load)}</span>
                    </div>
                    <div className="flex items-center gap-1 text-sm">
                      <MapPin className="h-3 w-3 text-muted-foreground" />
                      <span className="font-medium truncate">{load.origin}</span>
                      <ArrowRight className="h-3 w-3" />
                      <span className="font-medium truncate">{load.destination}</span>
                    </div>
                    {/* Match reason badges */}
                    <div className="flex flex-wrap gap-1">
                      {(load as any).truckTypeMatch && (
                        <Badge variant="outline" className="text-xs bg-blue-50 dark:bg-blue-950 no-default-hover-elevate no-default-active-elevate">
                          <Truck className="h-2.5 w-2.5 mr-1" />
                          Truck
                        </Badge>
                      )}
                      {(load as any).capacityMatch && (
                        <Badge variant="outline" className="text-xs bg-green-50 dark:bg-green-950 no-default-hover-elevate no-default-active-elevate">
                          <Package className="h-2.5 w-2.5 mr-1" />
                          Capacity
                        </Badge>
                      )}
                      {(load as any).routeMatch && (
                        <Badge variant="outline" className="text-xs bg-purple-50 dark:bg-purple-950 no-default-hover-elevate no-default-active-elevate">
                          <MapPin className="h-2.5 w-2.5 mr-1" />
                          Route
                        </Badge>
                      )}
                      {(load as any).commodityMatch && (
                        <Badge variant="outline" className="text-xs bg-orange-50 dark:bg-orange-950 no-default-hover-elevate no-default-active-elevate">
                          <Package className="h-2.5 w-2.5 mr-1" />
                          Cargo
                        </Badge>
                      )}
                      {(load as any).shipperMatch && (
                        <Badge variant="outline" className="text-xs bg-yellow-50 dark:bg-yellow-950 no-default-hover-elevate no-default-active-elevate">
                          <Building2 className="h-2.5 w-2.5 mr-1" />
                          Shipper
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-lg font-bold">{formatCurrency(getCarrierPrice(load))}</span>
                      <div className="flex gap-1">
                        {load.myBid ? (
                          <Button size="sm" disabled data-testid={`button-bid-rec-${load.id}`}>
                            Bid Placed
                          </Button>
                        ) : (
                          <>
                            <Button 
                              size="sm" 
                              onClick={(e) => { e.stopPropagation(); handleDirectAccept(load); }} 
                              data-testid={`button-accept-rec-${load.id}`}
                            >
                              Accept
                            </Button>
                            {!load.priceFixed && (
                              <Button 
                                size="sm" 
                                variant="outline"
                                onClick={(e) => { e.stopPropagation(); handlePlaceBid(load); }} 
                                data-testid={`button-bid-rec-${load.id}`}
                              >
                                Bid
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("carrier.searchLoadsPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-loads"
          />
        </div>
        <Select value={distanceFilter} onValueChange={setDistanceFilter}>
          <SelectTrigger className="w-full sm:w-36" data-testid="select-distance-filter">
            <SelectValue placeholder={t("loads.distance")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("carrier.allDistances")}</SelectItem>
            <SelectItem value="short">{t("carrier.under500km")}</SelectItem>
            <SelectItem value="medium">{t("carrier.500to1000km")}</SelectItem>
            <SelectItem value="long">{t("carrier.over1000km")}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={loadTypeFilter} onValueChange={setLoadTypeFilter}>
          <SelectTrigger className="w-full sm:w-36" data-testid="select-type-filter">
            <SelectValue placeholder={t("loads.loadType")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("carrier.allTypes")}</SelectItem>
            {loadTypes.map(type => (
              <SelectItem key={type} value={type}>{type}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sortBy} onValueChange={setSortBy}>
          <SelectTrigger className="w-full sm:w-36" data-testid="select-sort">
            <SelectValue placeholder={t("common.sortBy")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="match">{t("carrier.bestMatch")}</SelectItem>
            <SelectItem value="rate">{t("carrier.highestRate")}</SelectItem>
            <SelectItem value="distance">{t("carrier.shortest")}</SelectItem>
            <SelectItem value="newest">{t("carrier.newest")}</SelectItem>
          </SelectContent>
        </Select>
        <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as any)}>
          <TabsList>
            <TabsTrigger value="grid" data-testid="button-view-grid">
              <LayoutGrid className="h-4 w-4" />
            </TabsTrigger>
            <TabsTrigger value="list" data-testid="button-view-list">
              <List className="h-4 w-4" />
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {filteredAndSortedLoads.length === 0 ? (
        <EmptyState
          icon={Package}
          title={t("loads.noLoadsFound")}
          description={loads.length === 0 
            ? t("carrier.noLoadsPostedYet")
            : t("carrier.noLoadsMatchFilters")
          }
        />
      ) : viewMode === "grid" ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredAndSortedLoads.slice(0, 30).map((load) => (
            <Card 
              key={load.id} 
              className={`hover-elevate cursor-pointer ${highlightedId === load.id ? "ring-2 ring-primary ring-offset-2 animate-pulse" : ""}`} 
              data-testid={`load-card-${load.id}`}
              onClick={() => {
                setDetailLoad(load);
                setDetailDialogOpen(true);
              }}
            >
              <CardContent className="p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className={`${getMatchScoreBadge(load.matchScore)} no-default-hover-elevate no-default-active-elevate`}>
                      <Target className="h-3 w-3 mr-1" />
                      {load.matchScore}% {t("carrier.match")}
                    </Badge>
                    {load.postedByAdmin && !load.isSimulated && (
                      <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 no-default-hover-elevate no-default-active-elevate">
                        <ShieldCheck className="h-3 w-3 mr-1" />
                        Posted by Admin
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">{formatLoadId(load)}</span>
                </div>
                
                <div className="space-y-3">
                  <div className="flex items-start gap-2">
                    <MapPin className="h-4 w-4 text-green-500 mt-1 flex-shrink-0" />
                    <div>
                      <div className="font-medium">{load.origin}</div>
                      {load.pickupLocality && (
                        <div className="text-sm text-muted-foreground">{load.pickupLocality}</div>
                      )}
                      {load.pickupLandmark && (
                        <div className="text-xs text-muted-foreground">Near: {load.pickupLandmark}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <MapPin className="h-4 w-4 text-red-500 mt-1 flex-shrink-0" />
                    <div>
                      <div className="font-medium">{load.destination}</div>
                      {load.dropoffBusinessName && (
                        <div className="text-sm font-medium">{load.dropoffBusinessName}</div>
                      )}
                      {load.dropoffLocality && (
                        <div className="text-sm text-muted-foreground">{load.dropoffLocality}</div>
                      )}
                      {load.dropoffLandmark && (
                        <div className="text-xs text-muted-foreground">Near: {load.dropoffLandmark}</div>
                      )}
                    </div>
                  </div>
                </div>
                
                <div className="flex flex-wrap gap-2">
                  {load.loadType && <Badge variant="outline">{load.loadType}</Badge>}
                  {load.weight && <Badge variant="outline">{load.weight} Tons</Badge>}
                  {load.estimatedDistance && <Badge variant="outline">{load.estimatedDistance} km</Badge>}
                  <Badge 
                    variant="outline" 
                    className={load.priceFixed 
                      ? "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400" 
                      : "border-green-300 text-green-700 dark:border-green-700 dark:text-green-400"
                    }
                  >
                    {load.priceFixed ? (
                      <><Lock className="h-3 w-3 mr-1" />Fixed Price</>
                    ) : (
                      <><Unlock className="h-3 w-3 mr-1" />Negotiable</>
                    )}
                  </Badge>
                </div>
                
                                
                <div className="flex items-center justify-between pt-2 border-t gap-2">
                  <div>
                    <p className="text-xs text-muted-foreground">Total Price</p>
                    <p className="text-xl font-bold">{formatCurrency(getCarrierPrice(load))}</p>
                  </div>
                  <div className="flex gap-2">
                    {load.myBid ? (
                      <Button disabled data-testid={`button-bid-${load.id}`}>
                        Bid Placed
                      </Button>
                    ) : (
                      <>
                        <Button 
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDirectAccept(load);
                          }} 
                          data-testid={`button-accept-${load.id}`}
                        >
                          Accept
                        </Button>
                        {!load.priceFixed && (
                          <Button 
                            variant="outline"
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePlaceBid(load);
                            }} 
                            data-testid={`button-bid-${load.id}`}
                          >
                            Place Bid
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                
                {load.myBid && (
                  <div className="text-xs text-muted-foreground">
                    <Badge variant="secondary" className="no-default-hover-elevate no-default-active-elevate">
                      Your bid: {formatCurrency(parseFloat(load.myBid.counterAmount || load.myBid.amount))}
                      {load.myBid.status === "countered" && " (Countered)"}
                    </Badge>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ScrollArea className="h-[600px]">
              <div className="divide-y">
                {filteredAndSortedLoads.slice(0, 50).map((load) => (
                  <div key={load.id} className={`p-4 hover-elevate ${highlightedId === load.id ? "ring-2 ring-primary ring-offset-2 animate-pulse" : ""}`} data-testid={`load-row-${load.id}`}>
                    <div className="flex flex-col lg:flex-row lg:items-center gap-4">
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-3 flex-wrap">
                          <Badge className={`${getMatchScoreBadge(load.matchScore)} no-default-hover-elevate no-default-active-elevate`}>
                            <Target className="h-3 w-3 mr-1" />
                            {load.matchScore}%
                          </Badge>
                          <span className="text-sm text-muted-foreground">{formatLoadId(load)}</span>
                          {load.loadType && <Badge variant="outline">{load.loadType}</Badge>}
                          {load.myBid && (
                            <Badge variant="secondary" className="no-default-hover-elevate no-default-active-elevate">
                              Bid placed
                            </Badge>
                          )}
                        </div>
                        
                        <div className="flex items-center gap-2">
                          <MapPin className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{load.origin}</span>
                          <ArrowRight className="h-4 w-4" />
                          <span className="font-medium">{load.destination}</span>
                          {load.estimatedDistance && (
                            <span className="text-sm text-muted-foreground">({load.estimatedDistance} km)</span>
                          )}
                        </div>
                        
                        <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
                                                    {load.weight && (
                            <span className="flex items-center gap-1">
                              <Package className="h-4 w-4" />
                              {load.weight} Tons
                            </span>
                          )}
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className="text-xs text-muted-foreground">Rate</p>
                          <p className="text-xl font-bold">{formatCurrency(getCarrierPrice(load))}</p>
                        </div>
                        <div className="flex gap-2">
                          {load.myBid ? (
                            <Button disabled data-testid={`button-bid-list-${load.id}`}>
                              Placed
                            </Button>
                          ) : (
                            <>
                              <Button 
                                onClick={() => handleDirectAccept(load)} 
                                data-testid={`button-accept-list-${load.id}`}
                              >
                                Accept
                              </Button>
                              {!load.priceFixed && (
                                <Button 
                                  variant="outline"
                                  onClick={() => handlePlaceBid(load)} 
                                  data-testid={`button-bid-list-${load.id}`}
                                >
                                  Bid
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
      
      <p className="text-sm text-muted-foreground">
        Showing {Math.min(filteredAndSortedLoads.length, viewMode === "list" ? 50 : 30)} of {filteredAndSortedLoads.length} loads
      </p>

      {/* Load Detail Dialog */}
      <Dialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
        <DialogContent className="max-w-md p-0 !gap-0 overflow-hidden">
          <DialogHeader className="sr-only">
            <DialogTitle>Load Details</DialogTitle>
            <DialogDescription>Details for load {detailLoad ? formatLoadId(detailLoad) : ''}</DialogDescription>
          </DialogHeader>
          
          {detailLoad && (
            <div className="flex flex-col max-h-[70vh]">
              <div className="overflow-y-auto flex-1">
              <div className="px-5 pt-5 pb-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className={`${getMatchScoreBadge((detailLoad as any).matchScore || 80)} no-default-hover-elevate no-default-active-elevate`}>
                      <Target className="h-3 w-3 mr-1" />
                      {(detailLoad as any).matchScore || 80}% Match
                    </Badge>
                    {detailLoad.priceFixed ? (
                      <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 no-default-hover-elevate no-default-active-elevate">
                        <Lock className="h-3 w-3 mr-1" />Fixed
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 no-default-hover-elevate no-default-active-elevate">
                        <Unlock className="h-3 w-3 mr-1" />Negotiable
                      </Badge>
                    )}
                    {detailLoad.postedByAdmin && !(detailLoad as any).isSimulated && (
                      <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 no-default-hover-elevate no-default-active-elevate">
                        <ShieldCheck className="h-3 w-3 mr-1" />Admin
                      </Badge>
                    )}
                  </div>
                  <span className="text-sm font-mono text-muted-foreground">{formatLoadId(detailLoad)}</span>
                </div>

                <div className="relative pl-5 space-y-1">
                  <div className="absolute left-[7px] top-2 bottom-2 w-px border-l-2 border-dashed border-muted-foreground/30" />
                  <div className="flex items-start gap-3">
                    <div className="absolute left-0 mt-1 h-4 w-4 rounded-full bg-green-500 flex items-center justify-center">
                      <div className="h-1.5 w-1.5 rounded-full bg-white" />
                    </div>
                    <div className="ml-3">
                      <div className="font-semibold text-sm">{detailLoad.origin}</div>
                      {detailLoad.pickupAddress && <div className="text-xs text-muted-foreground">{detailLoad.pickupAddress}</div>}
                      {detailLoad.pickupLocality && <div className="text-xs text-muted-foreground">{detailLoad.pickupLocality}</div>}
                      {detailLoad.pickupLandmark && <div className="text-xs text-muted-foreground">Near: {detailLoad.pickupLandmark}</div>}
                    </div>
                  </div>
                  <div className="flex items-start gap-3 pt-3">
                    <div className="absolute left-0 mt-1 h-4 w-4 rounded-full bg-red-500 flex items-center justify-center">
                      <div className="h-1.5 w-1.5 rounded-full bg-white" />
                    </div>
                    <div className="ml-3">
                      <div className="font-semibold text-sm">{detailLoad.destination}</div>
                      {detailLoad.dropoffBusinessName && <div className="text-xs font-medium">{detailLoad.dropoffBusinessName}</div>}
                      {detailLoad.dropoffAddress && <div className="text-xs text-muted-foreground">{detailLoad.dropoffAddress}</div>}
                      {detailLoad.dropoffLocality && <div className="text-xs text-muted-foreground">{detailLoad.dropoffLocality}</div>}
                      {detailLoad.dropoffLandmark && <div className="text-xs text-muted-foreground">Near: {detailLoad.dropoffLandmark}</div>}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {detailLoad.loadType && (
                    <span className="flex items-center gap-1"><Truck className="h-3.5 w-3.5" />{detailLoad.loadType}</span>
                  )}
                  {detailLoad.weight && (
                    <span className="flex items-center gap-1"><Package className="h-3.5 w-3.5" />{detailLoad.weight} Tons</span>
                  )}
                  {detailLoad.estimatedDistance && (
                    <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{detailLoad.estimatedDistance} km</span>
                  )}
                  {detailLoad.cargoDescription && (
                    <span className="flex items-center gap-1"><Package className="h-3.5 w-3.5" />{detailLoad.cargoDescription}</span>
                  )}
                  {detailLoad.postedAt && (
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3.5 w-3.5" />
                      {new Date(detailLoad.postedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </span>
                  )}
                </div>
              </div>

              <div className="border-t px-5 py-4 bg-muted/30 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Total Price</span>
                  <span className="text-2xl font-bold text-primary">{formatCurrency(getCarrierPrice(detailLoad))}</span>
                </div>

                {(detailLoad.carrierAdvancePercent !== null && detailLoad.carrierAdvancePercent !== undefined && detailLoad.carrierAdvancePercent > 0) && (
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="p-2 rounded-md bg-background">
                      <p className="text-xs text-muted-foreground">Advance</p>
                      <p className="font-semibold text-sm text-green-600 dark:text-green-400">{detailLoad.carrierAdvancePercent}%</p>
                    </div>
                    <div className="p-2 rounded-md bg-background">
                      <p className="text-xs text-muted-foreground">Upfront</p>
                      <p className="font-semibold text-sm text-green-600 dark:text-green-400">
                        {formatCurrency(Math.round(getCarrierPrice(detailLoad) * (detailLoad.carrierAdvancePercent / 100)))}
                      </p>
                    </div>
                    <div className="p-2 rounded-md bg-background">
                      <p className="text-xs text-muted-foreground">On Delivery</p>
                      <p className="font-semibold text-sm">
                        {formatCurrency(Math.round(getCarrierPrice(detailLoad) * (1 - detailLoad.carrierAdvancePercent / 100)))}
                      </p>
                    </div>
                  </div>
                )}
                <p className="text-sm text-muted-foreground leading-snug">*Final price reflects a one-time TDS deduction if TDS declaration was not provided at the time of registration.</p>
              </div>

              {((detailLoad as any).matchScore > 0) && (
                <div className="border-t px-5 py-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <Target className="h-4 w-4 text-primary" />
                    <span className="text-sm font-semibold">Why This Load Matches</span>
                    <Badge variant="secondary" className="ml-auto no-default-hover-elevate no-default-active-elevate">
                      {(detailLoad as any).matchScore} pts
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(detailLoad as any).truckTypeMatch && (
                      <Badge variant="outline" className="text-xs gap-1 no-default-hover-elevate no-default-active-elevate">
                        <Truck className="h-3 w-3" />Truck Match +30
                      </Badge>
                    )}
                    {(detailLoad as any).capacityMatch && (
                      <Badge variant="outline" className="text-xs gap-1 no-default-hover-elevate no-default-active-elevate">
                        <Package className="h-3 w-3" />Capacity +25
                      </Badge>
                    )}
                    {(detailLoad as any).routeMatch && (
                      <Badge variant="outline" className="text-xs gap-1 no-default-hover-elevate no-default-active-elevate">
                        <MapPin className="h-3 w-3" />Route Exp +20
                      </Badge>
                    )}
                    {(detailLoad as any).commodityMatch && (
                      <Badge variant="outline" className="text-xs gap-1 no-default-hover-elevate no-default-active-elevate">
                        <Package className="h-3 w-3" />Commodity +15
                      </Badge>
                    )}
                    {(detailLoad as any).shipperMatch && (
                      <Badge variant="outline" className="text-xs gap-1 no-default-hover-elevate no-default-active-elevate">
                        <Building2 className="h-3 w-3" />Shipper Exp +10
                      </Badge>
                    )}
                  </div>
                </div>
              )}

              </div>
              <div className="border-t px-5 py-3 flex items-center justify-end gap-2 flex-shrink-0">
                {detailLoad?.myBid ? (
                  <Button disabled data-testid="button-bid-from-detail">
                    Bid Placed
                  </Button>
                ) : (
                  <>
                    {!detailLoad?.priceFixed && (
                      <Button 
                        variant="outline"
                        onClick={() => {
                          setDetailDialogOpen(false);
                          if (detailLoad) handlePlaceBid(detailLoad as any);
                        }}
                        data-testid="button-bid-from-detail"
                      >
                        Place Bid
                      </Button>
                    )}
                    <Button 
                      onClick={() => {
                        setDetailDialogOpen(false);
                        if (detailLoad) handleDirectAccept(detailLoad as any);
                      }}
                      data-testid="button-accept-from-detail"
                    >
                      Accept Load
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={bidDialogOpen} onOpenChange={setBidDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialogMode === "accept" ? "Accept Load" : "Place Bid"}
            </DialogTitle>
            <DialogDescription>
              {dialogMode === "accept" 
                ? "Confirm acceptance at the carrier payout price"
                : "Submit your counter-offer for this load"
              }
            </DialogDescription>
          </DialogHeader>
          
          {selectedLoad && (
            <div className="space-y-4 py-2">
              {/* Compact Load Summary */}
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-green-500" />
                  <span className="font-medium">{selectedLoad.origin}</span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  <MapPin className="h-4 w-4 text-red-500" />
                  <span className="font-medium">{selectedLoad.destination}</span>
                </div>
                <span className="text-muted-foreground">{formatLoadId(selectedLoad)}</span>
              </div>
              
              {/* Mode Toggle for negotiable loads */}
              {!selectedLoad.priceFixed && (
                <Tabs value={dialogMode} onValueChange={(v) => setDialogMode(v as "accept" | "bid")} className="w-full">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="accept" data-testid="tab-accept">
                      <CheckCircle className="h-4 w-4 mr-2" />
                      Accept
                    </TabsTrigger>
                    <TabsTrigger value="bid" data-testid="tab-bid">
                      <TrendingUp className="h-4 w-4 mr-2" />
                      Place Bid
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
              
              {/* Accept Mode View */}
              {dialogMode === "accept" && (
                <div className="space-y-4">
                  <div className="p-4 bg-green-50 dark:bg-green-950/30 rounded-lg border border-green-200 dark:border-green-800">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Your Payout</span>
                      <span className="text-2xl font-bold text-green-600 dark:text-green-400">
                        {formatCurrency(getCarrierPrice(selectedLoad))}
                      </span>
                    </div>
                  </div>
                  
                  {/* Truck/Driver Selection for Enterprise */}
                  {isEnterprise && (
                    <div className="space-y-3">
                      <Select value={selectedTruckId} onValueChange={setSelectedTruckId}>
                        <SelectTrigger data-testid="select-truck">
                          <Truck className="h-4 w-4 mr-2" />
                          <SelectValue placeholder="Select Truck *" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableTrucks.length === 0 ? (
                            <div className="p-2 text-sm text-muted-foreground text-center">
                              No available trucks
                            </div>
                          ) : (
                            availableTrucks.map((truck) => (
                              <SelectItem key={truck.id} value={truck.id}>
                                {truck.licensePlate} - {truck.truckType}
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                      
                      <Select value={selectedDriverId} onValueChange={setSelectedDriverId}>
                        <SelectTrigger data-testid="select-driver">
                          <SelectValue placeholder="Assign Driver" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="unassigned">Assign Later</SelectItem>
                          {availableDrivers.map((driver) => (
                            <SelectItem key={driver.id} value={driver.id}>
                              {driver.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  
                  <Button 
                    className="w-full"
                    onClick={handleAccept}
                    disabled={acceptDirectMutation.isPending || (isEnterprise && !selectedTruckId)}
                    data-testid="button-accept-load"
                  >
                    {acceptDirectMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Confirm Accept at {formatCurrency(getCarrierPrice(selectedLoad))}
                  </Button>
                  {isEnterprise && !selectedTruckId && (
                    <p className="text-xs text-destructive text-center">
                      Please select a truck to accept this load.
                    </p>
                  )}
                </div>
              )}
              
              {/* Bid Mode View */}
              {dialogMode === "bid" && (
                <div className="space-y-4">
                  <div className="p-4 bg-muted/50 rounded-lg border">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm text-muted-foreground">Admin Price</span>
                      <span className="text-lg font-medium">{formatCurrency(getCarrierPrice(selectedLoad))}</span>
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Your Bid Amount</label>
                      <Input
                        type="number"
                        placeholder=""
                        value={bidAmount}
                        onChange={(e) => setBidAmount(e.target.value)}
                        className="text-lg font-medium"
                        data-testid="input-bid-amount"
                      />
                    </div>
                  </div>
                  
                  {/* Truck/Driver Selection for Enterprise */}
                  {isEnterprise && (
                    <div className="space-y-3">
                      <Select value={selectedTruckId} onValueChange={setSelectedTruckId}>
                        <SelectTrigger data-testid="select-truck-bid">
                          <Truck className="h-4 w-4 mr-2" />
                          <SelectValue placeholder="Select Truck *" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableTrucks.length === 0 ? (
                            <div className="p-2 text-sm text-muted-foreground text-center">
                              No available trucks
                            </div>
                          ) : (
                            availableTrucks.map((truck) => (
                              <SelectItem key={truck.id} value={truck.id}>
                                {truck.licensePlate} - {truck.truckType}
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                      
                      <Select value={selectedDriverId} onValueChange={setSelectedDriverId}>
                        <SelectTrigger data-testid="select-driver-bid">
                          <SelectValue placeholder="Assign Driver" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="unassigned">Assign Later</SelectItem>
                          {availableDrivers.map((driver) => (
                            <SelectItem key={driver.id} value={driver.id}>
                              {driver.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  
                  <Button 
                    className="w-full"
                    onClick={submitBid}
                    disabled={!bidAmount || bidMutation.isPending || (isEnterprise && !selectedTruckId)}
                    data-testid="button-place-bid"
                  >
                    {bidMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    <TrendingUp className="h-4 w-4 mr-2" />
                    Submit Bid at {bidAmount ? formatCurrency(parseInt(bidAmount)) : "..."}
                  </Button>
                  {isEnterprise && !selectedTruckId && (
                    <p className="text-xs text-destructive text-center">
                      Please select a truck to place a bid.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setBidDialogOpen(false)} data-testid="button-cancel-bid">
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
