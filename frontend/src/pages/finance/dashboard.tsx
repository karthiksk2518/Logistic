import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Package, Truck, FileText, CheckCircle, AlertCircle, Clock, Eye,
  Search, DollarSign, Phone, Building2, XCircle, PauseCircle,
  User, MapPin, Filter, ArrowDown
} from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface FinanceShipment {
  id: string;
  loadId: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  load: {
    id: string;
    referenceNumber: number | null;
    pickupCity: string;
    pickupAddress: string;
    pickupState: string | null;
    pickupLocality: string | null;
    pickupLandmark: string | null;
    dropoffCity: string;
    dropoffAddress: string;
    dropoffState: string | null;
    dropoffLocality: string | null;
    dropoffLandmark: string | null;
    dropoffBusinessName: string | null;
    materialType: string | null;
    weight: string;
    requiredTruckType: string | null;
    pickupDate: string | null;
    deliveryDate: string | null;
    adminFinalPrice: string | null;
  } | null;
  shipper: {
    id: string;
    username: string;
    companyName: string;
    phone: string | null;
  } | null;
  carrier: {
    id: string;
    username: string;
    companyName: string;
    phone: string | null;
    carrierType: string;
  } | null;
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

const documentTypeLabels: Record<string, string> = {
  lr_consignment: "LR / Consignment Note",
  eway_bill: "E-way Bill",
  loading_photos: "Loading Photos",
  pod: "Proof of Delivery (POD)",
  invoice: "Invoice",
  other: "Other Document",
};

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

export default function FinanceDashboard() {
  const { toast } = useToast();
  const [selectedShipment, setSelectedShipment] = useState<FinanceShipment | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [reviewComment, setReviewComment] = useState("");

  const { data: shipments = [], isLoading } = useQuery<FinanceShipment[]>({
    queryKey: ["/api/finance/shipments"],
  });

  const reviewMutation = useMutation({
    mutationFn: async (data: { shipmentId: string; loadId: string; status: string; comment: string; paymentStatus?: string }) => {
      const res = await apiRequest("POST", "/api/finance/reviews", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/shipments"] });
      toast({ title: "Review Submitted", description: "Finance review has been recorded." });
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
      queryClient.invalidateQueries({ queryKey: ["/api/finance/shipments"] });
      toast({ title: "Payment Updated", description: "Payment status has been updated." });
    },
  });

  const filteredShipments = shipments.filter((s) => {
    const matchesSearch = searchQuery === "" ||
      s.load?.referenceNumber?.toString().includes(searchQuery) ||
      s.load?.pickupCity?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.load?.dropoffCity?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.carrier?.companyName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.shipper?.companyName?.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === "all" ||
      (statusFilter === "pending" && !s.financeReview) ||
      (statusFilter === "reviewed" && s.financeReview) ||
      s.financeReview?.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const stats = {
    total: shipments.length,
    pending: shipments.filter(s => !s.financeReview || s.financeReview.status === "pending").length,
    approved: shipments.filter(s => s.financeReview?.status === "approved").length,
    onHold: shipments.filter(s => s.financeReview?.status === "on_hold").length,
    rejected: shipments.filter(s => s.financeReview?.status === "rejected").length,
    paymentReleased: shipments.filter(s => s.financeReview?.paymentStatus === "released").length,
  };

  const handleReview = (status: string) => {
    if (!selectedShipment || !selectedShipment.load) return;
    reviewMutation.mutate({
      shipmentId: selectedShipment.id,
      loadId: selectedShipment.loadId,
      status,
      comment: reviewComment,
    });
  };

  return (
    <div className="flex h-full" data-testid="finance-dashboard">
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="p-4 border-b space-y-4">
          <h1 className="text-xl font-bold" data-testid="text-finance-title">Finance Document Review</h1>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            <Card className="p-3">
              <div className="text-xs text-muted-foreground">Total</div>
              <div className="text-lg font-bold" data-testid="stat-total">{stats.total}</div>
            </Card>
            <Card className="p-3">
              <div className="text-xs text-muted-foreground">Pending</div>
              <div className="text-lg font-bold text-yellow-600" data-testid="stat-pending">{stats.pending}</div>
            </Card>
            <Card className="p-3">
              <div className="text-xs text-muted-foreground">Approved</div>
              <div className="text-lg font-bold text-green-600" data-testid="stat-approved">{stats.approved}</div>
            </Card>
            <Card className="p-3">
              <div className="text-xs text-muted-foreground">On Hold</div>
              <div className="text-lg font-bold text-orange-600" data-testid="stat-on-hold">{stats.onHold}</div>
            </Card>
            <Card className="p-3">
              <div className="text-xs text-muted-foreground">Rejected</div>
              <div className="text-lg font-bold text-red-600" data-testid="stat-rejected">{stats.rejected}</div>
            </Card>
            <Card className="p-3">
              <div className="text-xs text-muted-foreground">Payment Released</div>
              <div className="text-lg font-bold text-green-600" data-testid="stat-released">{stats.paymentReleased}</div>
            </Card>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by reference, city, carrier, shipper..."
                className="pl-9"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                data-testid="input-search"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[160px]" data-testid="select-status-filter">
                <Filter className="h-4 w-4 mr-1" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Shipments</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="on_hold">On Hold</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-4 space-y-2">
            {isLoading ? (
              <div className="flex items-center justify-center py-16">
                <Clock className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : filteredShipments.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground" data-testid="text-no-shipments">
                No shipments found
              </div>
            ) : (
              filteredShipments.map((shipment) => {
                const reviewConfig = shipment.financeReview
                  ? reviewStatusConfig[shipment.financeReview.status] || reviewStatusConfig.pending
                  : reviewStatusConfig.pending;
                const paymentConfig = shipment.financeReview
                  ? paymentStatusConfig[shipment.financeReview.paymentStatus] || paymentStatusConfig.not_released
                  : paymentStatusConfig.not_released;
                const ReviewIcon = reviewConfig.icon;
                const docCount = shipment.documents.length;
                const isSelected = selectedShipment?.id === shipment.id;

                return (
                  <Card
                    key={shipment.id}
                    className={`cursor-pointer transition-all ${isSelected ? "ring-2 ring-primary" : ""}`}
                    onClick={() => {
                      setSelectedShipment(shipment);
                      setReviewComment(shipment.financeReview?.comment || "");
                    }}
                    data-testid={`shipment-card-${shipment.id}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4 flex-wrap">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="font-semibold text-sm">
                              Load #{shipment.load?.referenceNumber || "N/A"}
                            </span>
                            <Badge variant="outline" className="text-xs">
                              {shipment.status}
                            </Badge>
                            <Badge className={`text-xs ${reviewConfig.color}`}>
                              <ReviewIcon className="h-3 w-3 mr-1" />
                              {reviewConfig.label}
                            </Badge>
                            <Badge className={`text-xs ${paymentConfig.color}`}>
                              <DollarSign className="h-3 w-3 mr-1" />
                              {paymentConfig.label}
                            </Badge>
                          </div>
                          <div className="text-sm text-muted-foreground flex items-center gap-1">
                            <MapPin className="h-3 w-3" />
                            {shipment.load?.pickupCity || "N/A"} to {shipment.load?.dropoffCity || "N/A"}
                          </div>
                          <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground flex-wrap">
                            <span className="flex items-center gap-1">
                              <Building2 className="h-3 w-3" />
                              {shipment.carrier?.companyName || "N/A"}
                            </span>
                            <span className="flex items-center gap-1">
                              <FileText className="h-3 w-3" />
                              {docCount} doc{docCount !== 1 ? "s" : ""}
                            </span>
                            {shipment.load?.weight && (
                              <span>{shipment.load.weight} MT</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        </ScrollArea>
      </div>

      {selectedShipment && (
        <div className="w-[420px] border-l flex flex-col overflow-hidden bg-background">
          <div className="p-4 border-b flex items-center justify-between gap-2">
            <h2 className="font-semibold text-sm" data-testid="text-detail-title">
              Load #{selectedShipment.load?.referenceNumber || "N/A"}
            </h2>
            <Button variant="ghost" size="icon" onClick={() => setSelectedShipment(null)} data-testid="button-close-detail">
              <XCircle className="h-4 w-4" />
            </Button>
          </div>

          <ScrollArea className="flex-1">
            <div className="p-4 space-y-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Package className="h-4 w-4" /> Load Details
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm space-y-3">
                  <div className="space-y-2">
                    <div className="p-2 bg-muted/50 rounded-lg space-y-1">
                      <p className="text-xs text-muted-foreground font-medium flex items-center gap-1"><MapPin className="h-3 w-3" /> Pickup</p>
                      <p className="font-medium">{selectedShipment.load?.pickupAddress}</p>
                      {selectedShipment.load?.pickupLocality && (
                        <p className="text-muted-foreground">{selectedShipment.load.pickupLocality}</p>
                      )}
                      <p>{selectedShipment.load?.pickupCity}{selectedShipment.load?.pickupState ? `, ${selectedShipment.load.pickupState}` : ""}</p>
                      {selectedShipment.load?.pickupLandmark && (
                        <p className="text-xs text-muted-foreground">Landmark: {selectedShipment.load.pickupLandmark}</p>
                      )}
                      {selectedShipment.load?.pickupDate && (
                        <p className="text-xs text-muted-foreground">{format(new Date(selectedShipment.load.pickupDate), "MMM d, yyyy")}</p>
                      )}
                    </div>
                    <div className="flex justify-center">
                      <ArrowDown className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="p-2 bg-muted/50 rounded-lg space-y-1">
                      <p className="text-xs text-muted-foreground font-medium flex items-center gap-1"><MapPin className="h-3 w-3" /> Dropoff</p>
                      {selectedShipment.load?.dropoffBusinessName && (
                        <p className="font-medium">{selectedShipment.load.dropoffBusinessName}</p>
                      )}
                      <p className={selectedShipment.load?.dropoffBusinessName ? "" : "font-medium"}>{selectedShipment.load?.dropoffAddress}</p>
                      {selectedShipment.load?.dropoffLocality && (
                        <p className="text-muted-foreground">{selectedShipment.load.dropoffLocality}</p>
                      )}
                      <p>{selectedShipment.load?.dropoffCity}{selectedShipment.load?.dropoffState ? `, ${selectedShipment.load.dropoffState}` : ""}</p>
                      {selectedShipment.load?.dropoffLandmark && (
                        <p className="text-xs text-muted-foreground">Landmark: {selectedShipment.load.dropoffLandmark}</p>
                      )}
                      {selectedShipment.load?.deliveryDate && (
                        <p className="text-xs text-muted-foreground">{format(new Date(selectedShipment.load.deliveryDate), "MMM d, yyyy")}</p>
                      )}
                    </div>
                  </div>
                  <div className="space-y-1 pt-1 border-t">
                    <p><span className="text-muted-foreground">Material:</span> {selectedShipment.load?.materialType || "N/A"}</p>
                    <p><span className="text-muted-foreground">Weight:</span> {selectedShipment.load?.weight || "N/A"} MT</p>
                    <p><span className="text-muted-foreground">Truck Type:</span> {selectedShipment.load?.requiredTruckType?.replace(/_/g, " ") || "N/A"}</p>
                    {selectedShipment.load?.adminFinalPrice && (
                      <p><span className="text-muted-foreground">Price:</span> INR {parseFloat(selectedShipment.load.adminFinalPrice).toLocaleString()}</p>
                    )}
                    <p><span className="text-muted-foreground">Status:</span> <Badge variant="outline" className="text-xs ml-1">{selectedShipment.status?.replace(/_/g, " ")}</Badge></p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Truck className="h-4 w-4" /> Carrier Contact
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm space-y-1">
                  <p className="font-medium">{selectedShipment.carrier?.companyName || "N/A"}</p>
                  <p className="flex items-center gap-1">
                    <Badge variant="outline" className="text-xs">
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

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <User className="h-4 w-4" /> Shipper
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm space-y-1">
                  <p className="font-medium">{selectedShipment.shipper?.companyName || "N/A"}</p>
                  {selectedShipment.shipper?.phone && (
                    <p className="flex items-center gap-2">
                      <Phone className="h-3 w-3" />
                      {selectedShipment.shipper.phone}
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <FileText className="h-4 w-4" /> Shipment Documents
                  </CardTitle>
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
                    const doc = selectedShipment.documents.find(d => d.documentType === docItem.key);
                    const hasDocument = doc?.fileUrl;
                    const isVerified = doc?.isVerified === true;
                    return (
                      <div
                        key={docItem.key}
                        className={`flex items-center justify-between p-2 bg-muted/50 rounded-lg ${isVerified ? "cursor-pointer hover-elevate" : ""}`}
                        onClick={() => {
                          if (isVerified && doc.fileUrl) {
                            const url = doc.fileUrl.startsWith("http") || doc.fileUrl.startsWith("data:") || doc.fileUrl.startsWith("/objects/")
                              ? doc.fileUrl
                              : `/objects/${doc.fileUrl}`;
                            window.open(url, "_blank");
                          }
                        }}
                        data-testid={`finance-doc-${docItem.key}`}
                      >
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm">{docItem.label}</span>
                        </div>
                        <div>
                          {isVerified ? (
                            <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 cursor-pointer">
                              <CheckCircle className="h-3 w-3 mr-1" />
                              View
                            </Badge>
                          ) : hasDocument ? (
                            <Badge variant="outline" className="text-yellow-600 dark:text-yellow-400 border-yellow-300 dark:border-yellow-700">
                              <Clock className="h-3 w-3 mr-1" />
                              Awaiting Approval
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-muted-foreground">
                              Not Uploaded
                            </Badge>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <CheckCircle className="h-4 w-4" /> Document Review
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
                      className="bg-green-600 hover:bg-green-700 text-white"
                      onClick={() => handleReview("approved")}
                      disabled={reviewMutation.isPending}
                      data-testid="button-approve"
                    >
                      <CheckCircle className="h-3.5 w-3.5 mr-1" />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      className="bg-orange-500 hover:bg-orange-600 text-white"
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
                          className={selectedShipment.financeReview.paymentStatus === "released" ? "bg-green-600 hover:bg-green-700 text-white" : ""}
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
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
