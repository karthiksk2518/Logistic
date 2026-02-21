import { useState, useMemo, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { connectMarketplace, disconnectMarketplace, onMarketplaceEvent } from "@/lib/marketplace-socket";
import { useAuth } from "@/lib/auth-context";
import type { Load, FinanceReview } from "@shared/schema";
import { 
  Package, 
  Search, 
  Filter, 
  MoreHorizontal, 
  Edit, 
  Trash2, 
  Copy,
  UserPlus,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  MapPin,
  Truck,
  Weight,
  RefreshCw,
  DollarSign,
  Clock,
  CheckCircle,
  AlertCircle,
  Send,
  Receipt,
  Users,
  Loader2,
  Gavel,
  Navigation,
  Building2,
  FileCheck,
  PauseCircle,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useAdminData, type AdminLoad, type AdminCarrier } from "@/lib/admin-data-store";
import { format } from "date-fns";

type LoadWithBidCount = Load & { bidCount?: number; assignedCarrierName?: string | null };

function mapLoadStatus(status: string | null): AdminLoad["status"] {
  switch (status) {
    case "pending": return "Pending";
    case "submitted_to_admin": return "Pending";
    case "priced": return "Active";
    case "posted_to_carriers": return "Active";
    case "open_for_bid": return "Bidding";
    case "counter_received": return "Bidding";
    case "awarded": return "Assigned";
    case "invoice_created": return "Assigned";
    case "invoice_sent": return "Assigned";
    case "invoice_acknowledged": return "Assigned";
    case "invoice_approved": return "Assigned";
    case "invoice_negotiation": return "Assigned";
    case "invoice_paid": return "Assigned";
    case "in_transit": return "En Route";
    case "delivered": return "Delivered";
    case "closed": return "Delivered";
    case "cancelled": return "Cancelled";
    case "unavailable": return "Unavailable";
    default: return "Pending";
  }
}

function transformLoadToAdminLoad(load: LoadWithBidCount): AdminLoad {
  // Use sequential shipperLoadNumber for consistent LD-XXX format across all portals
  // If shipperLoadNumber is missing (legacy data), use short ID as fallback
  const loadId = load.shipperLoadNumber 
    ? `LD-${String(load.shipperLoadNumber).padStart(3, '0')}`
    : `LD-${load.id.slice(0, 6).toUpperCase()}`;
  
  return {
    loadId,
    pickupId: load.pickupId ?? undefined, // 4-digit code for carrier pickup verification
    shipperId: load.shipperId,
    shipperName: load.shipperCompanyName || load.shipperContactName || "Unknown Shipper",
    pickup: load.pickupCity,
    drop: load.dropoffCity,
    weight: parseFloat(String(load.weight)) || 0,
    weightUnit: load.weightUnit || "kg",
    type: load.requiredTruckType || "Any",
    status: mapLoadStatus(load.status),
    assignedCarrier: load.assignedCarrierName || null,
    carrierId: load.assignedCarrierId,
    createdDate: load.createdAt ? new Date(load.createdAt) : new Date(),
    eta: null,
    spending: parseFloat(String(load.adminFinalPrice || load.finalPrice || load.estimatedPrice || 0)),
    bidCount: load.bidCount || 0,
    distance: parseFloat(String(load.distance || 0)),
    dimensions: "",
    priority: load.priority === "high" ? "High" : load.priority === "critical" ? "Critical" : "Normal",
    title: load.goodsToBeCarried ?? undefined,
    description: load.specialNotes ?? undefined,
    requiredTruckType: load.requiredTruckType ?? undefined,
    _originalId: load.id,
  };
}


export default function AdminLoadsPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { updateLoad, updateLoadStatus, addActivity } = useAdminData();
  
  const { user } = useAuth();

  const { data: apiLoads = [], isLoading: isLoadingLoads, refetch: refetchLoads } = useQuery<LoadWithBidCount[]>({
    queryKey: ['/api/loads'],
  });

  type RealCarrier = {
    id: string;
    username: string;
    companyName: string | null;
    phone: string | null;
    isVerified: boolean | null;
    profile: {
      carrierType: string | null;
      totalDeliveries: number | null;
      fleetSize: number | null;
    } | null;
    bidCount: number;
  };

  const { data: realCarriers = [] } = useQuery<RealCarrier[]>({
    queryKey: ["/api/admin/carriers"],
  });

  const verifiedRealCarriers = useMemo(() => 
    realCarriers.filter(c => c.isVerified),
    [realCarriers]
  );

  const { data: financeReviews = [] } = useQuery<FinanceReview[]>({
    queryKey: ['/api/finance/reviews/all'],
    enabled: user?.role === "admin",
  });

  const financeReviewsByLoadId = useMemo(() => {
    const map: Record<string, FinanceReview> = {};
    financeReviews.forEach((r) => {
      if (r.loadId) map[r.loadId] = r;
    });
    return map;
  }, [financeReviews]);
  
  const loads: AdminLoad[] = useMemo(() => {
    return apiLoads.map(transformLoadToAdminLoad);
  }, [apiLoads]);
  
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortField, setSortField] = useState<keyof AdminLoad>("createdDate");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedLoad, setSelectedLoad] = useState<AdminLoad | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isAssignModalOpen, setIsAssignModalOpen] = useState(false);
  const [isStatusModalOpen, setIsStatusModalOpen] = useState(false);
  const [isPushModalOpen, setIsPushModalOpen] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isSendingInvoice, setIsSendingInvoice] = useState(false);
  const [formData, setFormData] = useState({
    pickup: "",
    drop: "",
    weight: "",
    type: "Open - 10 Wheeler",
    status: "Active" as AdminLoad["status"],
  });
  const [selectedCarrierId, setSelectedCarrierId] = useState<string>("");
  const itemsPerPage = 10;

  useEffect(() => {
    if (user?.id && user?.role === "admin") {
      connectMarketplace("admin", user.id);
      
      const unsubLoadPosted = onMarketplaceEvent("load_posted", (data) => {
        toast({
          title: "New Load Posted",
          description: `Load ${data.load?.pickupCity || ""} → ${data.load?.dropoffCity || ""} submitted by shipper`,
        });
        queryClient.invalidateQueries({ queryKey: ['/api/loads'] });
      });
      
      const unsubLoadSubmitted = onMarketplaceEvent("load_submitted", (data) => {
        toast({
          title: "New Load Submitted",
          description: `${data.shipperName || "Shipper"} submitted load: ${data.pickupCity || ""} → ${data.dropoffCity || ""}`,
        });
        queryClient.invalidateQueries({ queryKey: ['/api/loads'] });
      });
      
      const unsubLoadUpdate = onMarketplaceEvent("load_updated", (data) => {
        toast({
          title: "Load Updated",
          description: `Load ${data.load?.pickupCity || ""} → ${data.load?.dropoffCity || ""} status changed to ${data.status}`,
        });
        queryClient.invalidateQueries({ queryKey: ['/api/loads'] });
        queryClient.invalidateQueries({ queryKey: ['/api/bids'] });
      });

      const unsubBidReceived = onMarketplaceEvent("bid_received", (data) => {
        toast({
          title: "New Bid Received",
          description: `Carrier submitted a bid for Rs. ${parseFloat(data.bid?.amount || "0").toLocaleString("en-IN")}`,
        });
        queryClient.invalidateQueries({ queryKey: ['/api/loads'] });
      });

      return () => {
        unsubLoadPosted();
        unsubLoadSubmitted();
        unsubLoadUpdate();
        unsubBidReceived();
        disconnectMarketplace();
      };
    }
  }, [user?.id, user?.role, toast]);

  const filteredLoads = useMemo(() => {
    let result = [...loads];
    
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(load => 
        load.loadId?.toLowerCase().includes(query) ||
        load.pickupId?.toLowerCase().includes(query) ||
        load.pickup?.toLowerCase().includes(query) ||
        load.drop?.toLowerCase().includes(query) ||
        load.shipperName?.toLowerCase().includes(query) ||
        load.assignedCarrier?.toLowerCase().includes(query)
      );
    }
    
    if (statusFilter !== "all") {
      result = result.filter(load => load.status === statusFilter);
    }
    
    result.sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      const direction = sortDirection === "asc" ? 1 : -1;
      
      if (aVal instanceof Date && bVal instanceof Date) {
        return (aVal.getTime() - bVal.getTime()) * direction;
      }
      
      const aStr = String(aVal || "");
      const bStr = String(bVal || "");
      if (aStr < bStr) return -1 * direction;
      if (aStr > bStr) return 1 * direction;
      return 0;
    });
    
    return result;
  }, [loads, searchQuery, statusFilter, sortField, sortDirection]);

  const paginatedLoads = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredLoads.slice(start, start + itemsPerPage);
  }, [filteredLoads, currentPage]);

  const totalPages = Math.ceil(filteredLoads.length / itemsPerPage);

  const handleSort = (field: keyof AdminLoad) => {
    if (sortField === field) {
      setSortDirection(prev => prev === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const handleDuplicateLoad = (load: AdminLoad) => {
    toast({
      title: "Load Duplicated",
      description: `Created a copy of load ${load.loadId}`,
    });
    addActivity({
      type: "load",
      message: `Load ${load.loadId} duplicated`,
      entityId: load.loadId,
      severity: "info",
    });
  };

  const handleDeleteLoad = () => {
    if (selectedLoad) {
      updateLoadStatus(selectedLoad.loadId, "Cancelled");
      toast({
        title: "Load Cancelled",
        description: `Load ${selectedLoad.loadId} has been cancelled`,
      });
      setIsDeleteModalOpen(false);
      setSelectedLoad(null);
    }
  };

  const handleUpdateLoad = () => {
    if (selectedLoad) {
      updateLoad(selectedLoad.loadId, {
        pickup: formData.pickup,
        drop: formData.drop,
        weight: parseInt(formData.weight) || selectedLoad.weight,
        type: formData.type,
        status: formData.status,
      });
      
      toast({
        title: "Load Updated",
        description: `Load ${selectedLoad.loadId} has been updated`,
      });
      setIsEditModalOpen(false);
      setSelectedLoad(null);
    }
  };

  const handleAssignCarrier = async () => {
    if (selectedLoad && selectedCarrierId) {
      const carrier = verifiedRealCarriers.find(c => c.id === selectedCarrierId);
      if (carrier) {
        try {
          const apiLoad = apiLoads.find(l => l.id === selectedLoad.loadId);
          const carrierPayout = apiLoad?.finalPrice || "0";
          const shipperGross = apiLoad?.adminFinalPrice || apiLoad?.adminSuggestedPrice || carrierPayout;

          await apiRequest("POST", "/api/admin/assign", {
            load_id: selectedLoad.loadId,
            carrier_id: carrier.id,
            final_price: carrierPayout,
            gross_price: shipperGross,
          });

          queryClient.invalidateQueries({ queryKey: ["/api/loads"] });
          queryClient.invalidateQueries({ queryKey: ["/api/carrier/my-orders"] });

          toast({
            title: "Carrier Assigned",
            description: `${carrier.companyName || carrier.username} assigned to this load`,
          });
        } catch (error: any) {
          toast({
            title: "Assignment Failed",
            description: error.message || "Could not assign carrier",
            variant: "destructive",
          });
        }
      }
      setIsAssignModalOpen(false);
      setSelectedLoad(null);
      setSelectedCarrierId("");
    }
  };

  const handleStatusChange = (newStatus: AdminLoad["status"]) => {
    if (selectedLoad) {
      updateLoadStatus(selectedLoad.loadId, newStatus);
      toast({
        title: "Status Updated",
        description: `Load ${selectedLoad.loadId} is now ${newStatus}`,
      });
      setIsStatusModalOpen(false);
      setSelectedLoad(null);
    }
  };

  const handlePushToCarriers = async () => {
    if (!selectedLoad) return;
    
    setIsPushing(true);
    try {
      updateLoadStatus(selectedLoad.loadId, "Bidding");
      addActivity({
        type: "load",
        message: `Load ${selectedLoad.loadId} pushed to carrier marketplace`,
        entityId: selectedLoad.loadId,
        severity: "success",
      });
      
      toast({
        title: "Load Pushed to Carriers",
        description: `Load ${selectedLoad.loadId} is now available for carriers to bid`,
      });
      setIsPushModalOpen(false);
      setSelectedLoad(null);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to push load to carriers",
        variant: "destructive",
      });
    } finally {
      setIsPushing(false);
    }
  };

  const handleSendInvoice = async (load: AdminLoad) => {
    setIsSendingInvoice(true);
    try {
      addActivity({
        type: "transaction",
        message: `Invoice sent to ${load.shipperName} for load ${load.loadId}`,
        entityId: load.loadId,
        severity: "success",
      });
      
      toast({
        title: "Invoice Sent",
        description: `Invoice for load ${load.loadId} sent to ${load.shipperName}`,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to send invoice",
        variant: "destructive",
      });
    } finally {
      setIsSendingInvoice(false);
    }
  };

  const openEditModal = (load: AdminLoad) => {
    setSelectedLoad(load);
    setFormData({
      pickup: load.pickup || "",
      drop: load.drop || "",
      weight: load.weight?.toString() || "",
      type: load.type || "Open - 10 Wheeler",
      status: load.status,
    });
    setIsEditModalOpen(true);
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case "Delivered": return "bg-green-600";
      case "En Route": return "bg-blue-600";
      case "Assigned": return "bg-purple-600";
      case "Bidding": return "bg-amber-600";
      case "Active": return "bg-cyan-600";
      case "Cancelled": return "bg-red-600";
      case "Pending": return "bg-gray-600";
      case "Unavailable": return "bg-slate-600";
      default: return "";
    }
  };

  const formatCurrency = (value: number) => {
    return `Rs. ${value.toLocaleString("en-IN")}`;
  };

  // Calculate status counts for tabs
  const statusCounts = useMemo(() => {
    return {
      all: loads.length,
      Pending: loads.filter(l => l.status === "Pending").length,
      Active: loads.filter(l => l.status === "Active").length,
      Bidding: loads.filter(l => l.status === "Bidding").length,
      Assigned: loads.filter(l => l.status === "Assigned").length,
      "En Route": loads.filter(l => l.status === "En Route").length,
      Delivered: loads.filter(l => l.status === "Delivered").length,
      Cancelled: loads.filter(l => l.status === "Cancelled").length,
      Unavailable: loads.filter(l => l.status === "Unavailable").length,
    };
  }, [loads]);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Button 
              variant="ghost" 
              size="icon"
              onClick={() => setLocation("/admin")}
              data-testid="button-back-to-dashboard"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <h1 className="text-2xl font-bold">Loads Management</h1>
          </div>
          <p className="text-muted-foreground ml-10">Manage all platform loads ({loads.length} total)</p>
        </div>
        <Button 
          variant="outline" 
          onClick={() => refetchLoads()} 
          disabled={isLoadingLoads}
          data-testid="button-sync-loads"
        >
          {isLoadingLoads ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-2" />
          )}
          Sync from Portal
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-5">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
                <Package className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total</p>
                <p className="text-xl font-bold">{loads.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/30">
                <Clock className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Active</p>
                <p className="text-xl font-bold">{loads.filter(l => ["Active", "Bidding"].includes(l.status)).length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/30">
                <Truck className="h-5 w-5 text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">In Transit</p>
                <p className="text-xl font-bold">{loads.filter(l => l.status === "En Route").length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100 dark:bg-green-900/30">
                <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Delivered</p>
                <p className="text-xl font-bold">{loads.filter(l => l.status === "Delivered").length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                <DollarSign className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Revenue</p>
                <p className="text-xl font-bold">Rs. {(loads.reduce((sum, l) => sum + l.spending, 0) / 100000).toFixed(1)}L</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Status Tabs */}
      <Tabs value={statusFilter} onValueChange={setStatusFilter} className="w-full">
        <TabsList className="w-full justify-start h-auto flex-wrap gap-1 bg-transparent p-0">
          <TabsTrigger 
            value="all" 
            className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            data-testid="tab-all"
          >
            All ({statusCounts.all})
          </TabsTrigger>
          <TabsTrigger 
            value="Pending" 
            className="data-[state=active]:bg-gray-600 data-[state=active]:text-white"
            data-testid="tab-pending"
          >
            Pending ({statusCounts.Pending})
          </TabsTrigger>
          <TabsTrigger 
            value="Active" 
            className="data-[state=active]:bg-cyan-600 data-[state=active]:text-white"
            data-testid="tab-active"
          >
            Active ({statusCounts.Active})
          </TabsTrigger>
          <TabsTrigger 
            value="Bidding" 
            className="data-[state=active]:bg-amber-600 data-[state=active]:text-white"
            data-testid="tab-bidding"
          >
            Bidding ({statusCounts.Bidding})
          </TabsTrigger>
          <TabsTrigger 
            value="Assigned" 
            className="data-[state=active]:bg-purple-600 data-[state=active]:text-white"
            data-testid="tab-assigned"
          >
            Assigned ({statusCounts.Assigned})
          </TabsTrigger>
          <TabsTrigger 
            value="En Route" 
            className="data-[state=active]:bg-blue-600 data-[state=active]:text-white"
            data-testid="tab-in-transit"
          >
            In Transit ({statusCounts["En Route"]})
          </TabsTrigger>
          <TabsTrigger 
            value="Delivered" 
            className="data-[state=active]:bg-green-600 data-[state=active]:text-white"
            data-testid="tab-delivered"
          >
            Delivered ({statusCounts.Delivered})
          </TabsTrigger>
          <TabsTrigger 
            value="Cancelled" 
            className="data-[state=active]:bg-red-600 data-[state=active]:text-white"
            data-testid="tab-cancelled"
          >
            Cancelled ({statusCounts.Cancelled})
          </TabsTrigger>
          <TabsTrigger 
            value="Unavailable" 
            className="data-[state=active]:bg-slate-600 data-[state=active]:text-white"
            data-testid="tab-unavailable"
          >
            Unavailable ({statusCounts.Unavailable})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <Card>
        <CardHeader className="pb-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by Load ID, Pickup ID, route, shipper, or carrier..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              data-testid="input-search-loads"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-8 -ml-3"
                      onClick={() => handleSort("loadId")}
                      data-testid="button-sort-id"
                    >
                      Load ID
                      <ArrowUpDown className="ml-2 h-3 w-3" />
                    </Button>
                  </TableHead>
                  <TableHead className="w-[80px]">Pickup ID</TableHead>
                  <TableHead>Shipper</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-8 -ml-3"
                      onClick={() => handleSort("status")}
                      data-testid="button-sort-status"
                    >
                      Status
                      <ArrowUpDown className="ml-2 h-3 w-3" />
                    </Button>
                  </TableHead>
                  <TableHead>Carrier</TableHead>
                  <TableHead>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-8 -ml-3"
                      onClick={() => handleSort("spending")}
                      data-testid="button-sort-price"
                    >
                      Price
                      <ArrowUpDown className="ml-2 h-3 w-3" />
                    </Button>
                  </TableHead>
                  <TableHead>Review</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedLoads.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                      No loads found
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedLoads.map((load) => (
                    <TableRow 
                      key={load.loadId} 
                      className="cursor-pointer hover-elevate"
                      onClick={() => setLocation(`/admin/loads/${load._originalId || load.loadId}`)}
                      data-testid={`row-load-${load.loadId}`}
                    >
                      <TableCell className="font-mono font-medium" data-testid={`text-load-id-${load.loadId}`}>
                        {load.loadId}
                      </TableCell>
                      <TableCell className="font-mono text-xs" data-testid={`text-pickup-id-${load.loadId}`}>
                        {load.pickupId ? (
                          <Badge variant="outline" className="font-mono">
                            {load.pickupId}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div className="font-medium" data-testid={`text-shipper-${load.loadId}`}>
                            {load.shipperName}
                          </div>
                          <div className="text-muted-foreground text-xs">
                            {format(load.createdDate, "MMM d, yyyy")}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2" data-testid={`text-route-${load.loadId}`}>
                          <MapPin className="h-3 w-3 text-green-500" />
                          <span className="text-sm">{load.pickup}</span>
                          <span className="text-muted-foreground">-</span>
                          <MapPin className="h-3 w-3 text-red-500" />
                          <span className="text-sm">{load.drop}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm space-y-1">
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <Weight className="h-3 w-3" />
                            {load.weight?.toLocaleString()} tonnes
                          </div>
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <Truck className="h-3 w-3" />
                            {load.type}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge 
                          className={`${getStatusBadgeColor(load.status)} cursor-pointer`} 
                          data-testid={`badge-status-${load.loadId}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedLoad(load);
                            setIsStatusModalOpen(true);
                          }}
                        >
                          {load.status}
                        </Badge>
                      </TableCell>
                      <TableCell data-testid={`text-carrier-${load.loadId}`}>
                        {load.assignedCarrier ? (
                          <span className="text-sm">{load.assignedCarrier}</span>
                        ) : (
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            className="h-7 text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedLoad(load);
                              setIsAssignModalOpen(true);
                            }}
                          >
                            <UserPlus className="h-3 w-3 mr-1" />
                            Assign
                          </Button>
                        )}
                      </TableCell>
                      <TableCell data-testid={`text-price-${load.loadId}`}>
                        <div className="text-sm font-medium">{formatCurrency(load.spending)}</div>
                        {load.bidCount > 0 && (
                          <div className="text-xs text-muted-foreground">{load.bidCount} bids</div>
                        )}
                      </TableCell>
                      <TableCell data-testid={`text-review-${load.loadId}`}>
                        {(() => {
                          const review = financeReviewsByLoadId[load._originalId || ""];
                          if (!review) {
                            return <span className="text-xs text-muted-foreground">-</span>;
                          }
                          const statusConfig: Record<string, { label: string; className: string }> = {
                            pending: { label: "Pending", className: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300" },
                            approved: { label: "Approved", className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300" },
                            on_hold: { label: "On Hold", className: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300" },
                            rejected: { label: "Rejected", className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300" },
                          };
                          const paymentConfig: Record<string, { label: string; className: string }> = {
                            not_released: { label: "Not Released", className: "bg-muted text-muted-foreground" },
                            processing: { label: "Processing", className: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300" },
                            released: { label: "Released", className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300" },
                          };
                          const s = statusConfig[review.status] || statusConfig.pending;
                          const p = paymentConfig[review.paymentStatus || "not_released"] || paymentConfig.not_released;
                          return (
                            <div className="flex flex-col gap-1">
                              <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${s.className}`}>{s.label}</Badge>
                              <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${p.className}`}>{p.label}</Badge>
                            </div>
                          );
                        })()}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                            <Button variant="ghost" size="icon" data-testid={`button-load-actions-${load.loadId}`}>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={(e) => {
                              e.stopPropagation();
                              openEditModal(load);
                            }} data-testid={`menu-edit-${load.loadId}`}>
                              <Edit className="h-4 w-4 mr-2" />
                              Edit Load
                            </DropdownMenuItem>
                            {/* Cross-links for workflow connectivity */}
                            {(load.status === "Bidding" || load.status === "Active") && (
                              <DropdownMenuItem onClick={(e) => {
                                e.stopPropagation();
                                setLocation(`/admin/negotiations?load=${load._originalId || load.loadId}`);
                              }} data-testid={`menu-view-bids-${load.loadId}`}>
                                <Gavel className="h-4 w-4 mr-2" />
                                View Bids
                              </DropdownMenuItem>
                            )}
                            {load.status === "In Transit" && (
                              <DropdownMenuItem onClick={(e) => {
                                e.stopPropagation();
                                setLocation("/admin/tracking");
                              }} data-testid={`menu-track-${load.loadId}`}>
                                <Navigation className="h-4 w-4 mr-2" />
                                Live Tracking
                              </DropdownMenuItem>
                            )}
                            {/* Profile links for workflow connectivity */}
                            {load.shipperId && (
                              <DropdownMenuItem onClick={(e) => {
                                e.stopPropagation();
                                setLocation(`/admin/users?userId=${load.shipperId}&role=shipper`);
                              }} data-testid={`menu-view-shipper-${load.loadId}`}>
                                <Building2 className="h-4 w-4 mr-2" />
                                View Shipper
                              </DropdownMenuItem>
                            )}
                            {load.carrierId && (
                              <DropdownMenuItem onClick={(e) => {
                                e.stopPropagation();
                                setLocation(`/admin/carriers/${load.carrierId}`);
                              }} data-testid={`menu-view-carrier-${load.loadId}`}>
                                <Truck className="h-4 w-4 mr-2" />
                                View Carrier
                              </DropdownMenuItem>
                            )}
                            {!load.assignedCarrier && (
                              <DropdownMenuItem onClick={(e) => {
                                e.stopPropagation();
                                setSelectedLoad(load);
                                setIsAssignModalOpen(true);
                              }} data-testid={`menu-assign-${load.loadId}`}>
                                <UserPlus className="h-4 w-4 mr-2" />
                                Assign Carrier
                              </DropdownMenuItem>
                            )}
                            {!load.assignedCarrier && load.status !== "Bidding" && (
                              <DropdownMenuItem onClick={(e) => {
                                e.stopPropagation();
                                setSelectedLoad(load);
                                setIsPushModalOpen(true);
                              }} data-testid={`menu-push-${load.loadId}`}>
                                <Users className="h-4 w-4 mr-2" />
                                Push to Carriers
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={(e) => {
                              e.stopPropagation();
                              handleSendInvoice(load);
                            }} data-testid={`menu-invoice-${load.loadId}`}>
                              <Receipt className="h-4 w-4 mr-2" />
                              Send Invoice
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={(e) => {
                              e.stopPropagation();
                              setSelectedLoad(load);
                              setIsStatusModalOpen(true);
                            }}>
                              <AlertCircle className="h-4 w-4 mr-2" />
                              Change Status
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={(e) => {
                              e.stopPropagation();
                              handleDuplicateLoad(load);
                            }} data-testid={`menu-duplicate-${load.loadId}`}>
                              <Copy className="h-4 w-4 mr-2" />
                              Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem 
                              className="text-destructive"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedLoad(load);
                                setIsDeleteModalOpen(true);
                              }}
                              data-testid={`menu-delete-${load.loadId}`}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Cancel Load
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {filteredLoads.length > 0 && (
            <div className="flex items-center justify-between px-6 py-4 border-t">
              <p className="text-sm text-muted-foreground" data-testid="text-pagination-info">
                Showing {((currentPage - 1) * itemsPerPage) + 1} to {Math.min(currentPage * itemsPerPage, filteredLoads.length)} of {filteredLoads.length} loads
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                  disabled={currentPage === 1}
                  data-testid="button-prev-page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm px-2">
                  Page {currentPage} of {totalPages || 1}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                  disabled={currentPage === totalPages || totalPages === 0}
                  data-testid="button-next-page"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={isEditModalOpen} onOpenChange={(open) => { if (!open) { setIsEditModalOpen(false); setSelectedLoad(null); } }}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Edit Load</DialogTitle>
            <DialogDescription>Update load information. Changes sync to Shipper Portal.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Pickup Location</Label>
                <Input 
                  value={formData.pickup}
                  onChange={(e) => setFormData(prev => ({ ...prev, pickup: e.target.value }))}
                  data-testid="input-pickup" 
                />
              </div>
              <div className="space-y-2">
                <Label>Drop Location</Label>
                <Input 
                  value={formData.drop}
                  onChange={(e) => setFormData(prev => ({ ...prev, drop: e.target.value }))}
                  data-testid="input-drop" 
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Weight (lbs)</Label>
                <Input 
                  type="number" 
                  value={formData.weight}
                  onChange={(e) => setFormData(prev => ({ ...prev, weight: e.target.value }))}
                  data-testid="input-weight" 
                />
              </div>
              <div className="space-y-2">
                <Label>Truck Type</Label>
                <Select value={formData.type} onValueChange={(v) => setFormData(prev => ({ ...prev, type: v }))}>
                  <SelectTrigger data-testid="select-truck-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Open - 10 Wheeler">Open - 10 Wheeler</SelectItem>
                    <SelectItem value="Open - 14 Wheeler">Open - 14 Wheeler</SelectItem>
                    <SelectItem value="Open - 16 Wheeler">Open - 16 Wheeler</SelectItem>
                    <SelectItem value="Open - 18 Wheeler">Open - 18 Wheeler</SelectItem>
                    <SelectItem value="Container - 20 Ft">Container - 20 Ft</SelectItem>
                    <SelectItem value="Container - 32 Ft">Container - 32 Ft</SelectItem>
                    <SelectItem value="Container - 40 Ft">Container - 40 Ft</SelectItem>
                    <SelectItem value="Trailer - 40 Ft">Trailer - 40 Ft</SelectItem>
                    <SelectItem value="LCV - Tata Ace">LCV - Tata Ace</SelectItem>
                    <SelectItem value="Tanker - Oil/Fuel">Tanker - Oil/Fuel</SelectItem>
                    <SelectItem value="Tipper - 10 Wheeler">Tipper - 10 Wheeler</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={formData.status} onValueChange={(v) => setFormData(prev => ({ ...prev, status: v as AdminLoad["status"] }))}>
                <SelectTrigger data-testid="select-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Pending">Pending</SelectItem>
                  <SelectItem value="Active">Active</SelectItem>
                  <SelectItem value="Bidding">Bidding</SelectItem>
                  <SelectItem value="Assigned">Assigned</SelectItem>
                  <SelectItem value="En Route">In Transit</SelectItem>
                  <SelectItem value="Delivered">Delivered</SelectItem>
                  <SelectItem value="Cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsEditModalOpen(false); setSelectedLoad(null); }} data-testid="button-cancel-edit">
              Cancel
            </Button>
            <Button onClick={handleUpdateLoad} data-testid="button-save-load">
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isAssignModalOpen} onOpenChange={(open) => { if (!open) { setIsAssignModalOpen(false); setSelectedLoad(null); setSelectedCarrierId(""); } }}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Assign Carrier</DialogTitle>
            <DialogDescription>
              Select a verified carrier to assign to load {selectedLoad?.loadId}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="space-y-2">
              <Label>Select Carrier</Label>
              <Select value={selectedCarrierId} onValueChange={setSelectedCarrierId}>
                <SelectTrigger data-testid="select-carrier">
                  <SelectValue placeholder="Choose a carrier..." />
                </SelectTrigger>
                <SelectContent>
                  {verifiedRealCarriers.map((carrier) => (
                    <SelectItem key={carrier.id} value={carrier.id}>
                      <div className="flex items-center gap-2">
                        <span>{carrier.companyName || carrier.username}</span>
                        <Badge variant={carrier.profile?.carrierType === "solo" ? "secondary" : "outline"} className="text-[9px] px-1 py-0">
                          {carrier.profile?.carrierType === "solo" ? "Solo" : "Fleet"}
                        </Badge>
                        <span className="text-xs text-muted-foreground">({carrier.profile?.totalDeliveries || 0} loads)</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selectedCarrierId && (
              <div className="mt-4 p-3 bg-muted rounded-lg">
                {(() => {
                  const carrier = verifiedRealCarriers.find(c => c.id === selectedCarrierId);
                  return carrier ? (
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Type</span>
                        <span className="font-medium">{carrier.profile?.carrierType === "solo" ? "Solo Driver" : "Fleet Carrier"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Phone</span>
                        <span className="font-medium">{carrier.phone || "---"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Completed Loads</span>
                        <span className="font-medium">{carrier.profile?.totalDeliveries || 0}</span>
                      </div>
                    </div>
                  ) : null;
                })()}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsAssignModalOpen(false); setSelectedLoad(null); setSelectedCarrierId(""); }}>
              Cancel
            </Button>
            <Button onClick={handleAssignCarrier} disabled={!selectedCarrierId} data-testid="button-confirm-assign">
              Assign Carrier
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isStatusModalOpen} onOpenChange={(open) => { if (!open) { setIsStatusModalOpen(false); setSelectedLoad(null); } }}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Change Load Status</DialogTitle>
            <DialogDescription>
              Update status for load {selectedLoad?.loadId}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-2">
            {(["Pending", "Active", "Bidding", "Assigned", "En Route", "Delivered", "Cancelled"] as AdminLoad["status"][]).map((status) => (
              <Button
                key={status}
                variant={selectedLoad?.status === status ? "default" : "outline"}
                className="w-full justify-start"
                onClick={() => handleStatusChange(status)}
              >
                <Badge className={`${getStatusBadgeColor(status)} mr-2`}>{status}</Badge>
                {status === selectedLoad?.status && "(Current)"}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isDeleteModalOpen} onOpenChange={setIsDeleteModalOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Cancel Load</DialogTitle>
            <DialogDescription>
              Are you sure you want to cancel load {selectedLoad?.loadId}? This will update the status to Cancelled.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteModalOpen(false)} data-testid="button-cancel-delete">
              Keep Load
            </Button>
            <Button variant="destructive" onClick={handleDeleteLoad} data-testid="button-confirm-delete">
              Cancel Load
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isPushModalOpen} onOpenChange={(open) => { if (!open) { setIsPushModalOpen(false); setSelectedLoad(null); } }}>
        <DialogContent className="sm:max-w-[450px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              Push Load to Carriers
            </DialogTitle>
            <DialogDescription>
              Make load {selectedLoad?.loadId} available to all carriers for bidding.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {selectedLoad && (
              <div className="space-y-3 p-4 bg-muted rounded-lg">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Route</span>
                  <span className="font-medium">{selectedLoad.pickup} - {selectedLoad.drop}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Shipper</span>
                  <span className="font-medium">{selectedLoad.shipperName}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Price</span>
                  <span className="font-medium">{formatCurrency(selectedLoad.spending)}</span>
                </div>
              </div>
            )}
            <p className="mt-4 text-sm text-muted-foreground">
              Once pushed, carriers will be able to view and bid on this load in their marketplace.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsPushModalOpen(false); setSelectedLoad(null); }}>
              Cancel
            </Button>
            <Button onClick={handlePushToCarriers} disabled={isPushing} data-testid="button-confirm-push">
              {isPushing ? "Pushing..." : "Push to Carriers"}
              <Send className="h-4 w-4 ml-2" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}