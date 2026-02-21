import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/hooks/use-toast";
import {
  Package, MapPin, Calendar, Clock, ArrowRight,
  Loader2, RefreshCw, Truck, DollarSign, CheckCircle,
  AlertCircle, ClipboardList, ChevronRight, User,
  Phone, Building2, Weight, FileText, Hash, IndianRupee,
  CircleDot, Info, X
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { EmptyState } from "@/components/empty-state";
import type { Load } from "@shared/schema";
import { format } from "date-fns";
import { queryClient } from "@/lib/queryClient";

type OrderLoad = Load & {
  shipperName?: string;
  shipperPhone?: string | null;
  shipmentId?: string | null;
  shipmentStatus?: string | null;
  assignedBy?: string;
  assignedAt?: string | Date;
};

function formatCurrency(amount: number): string {
  return `Rs. ${amount.toLocaleString("en-IN")}`;
}

function formatLoadId(load: OrderLoad): string {
  if (load.adminReferenceNumber) {
    return `LD-${load.adminReferenceNumber}`;
  }
  if (load.shipperLoadNumber) {
    return `LD-${String(load.shipperLoadNumber).padStart(3, '0')}`;
  }
  return "---";
}

function formatShipmentId(uuid: string): string {
  const clean = uuid.replace(/-/g, "").toUpperCase();
  return `SH-${clean.slice(0, 8)}`;
}

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; className: string }> = {
  awarded: { label: "Assigned", variant: "default", className: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  invoice_created: { label: "Invoice Created", variant: "secondary", className: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" },
  invoice_sent: { label: "Invoice Sent", variant: "secondary", className: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400" },
  invoice_acknowledged: { label: "Invoice Acknowledged", variant: "secondary", className: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400" },
  invoice_paid: { label: "Invoice Paid", variant: "default", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" },
  in_transit: { label: "In Transit", variant: "default", className: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  delivered: { label: "Delivered", variant: "default", className: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
  closed: { label: "Closed", variant: "secondary", className: "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400" },
  cancelled: { label: "Cancelled", variant: "destructive", className: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
};

function getStatusBadge(status: string | null | undefined) {
  const config = statusConfig[status || ""] || { label: status || "Unknown", className: "bg-gray-100 text-gray-700" };
  return (
    <Badge className={config.className} data-testid={`badge-status-${status}`}>
      {config.label}
    </Badge>
  );
}

function DetailRow({ icon: Icon, label, value, className }: { icon?: any; label: string; value: string | number | null | undefined; className?: string }) {
  if (!value && value !== 0) return null;
  return (
    <div className={`flex items-start gap-3 py-2 ${className || ""}`}>
      {Icon && <Icon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />}
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium break-words">{value}</p>
      </div>
    </div>
  );
}

function OrderDetailSheet({ order, open, onClose }: { order: OrderLoad | null; open: boolean; onClose: () => void }) {
  if (!order) return null;

  const price = parseFloat(order.finalPrice || "0");
  const grossPrice = 0;
  const perTonRate = order.rateType === "per_ton" && order.shipperPricePerTon
    ? parseFloat(order.shipperPricePerTon)
    : null;
  const carrierAdvPct = Number(order.carrierAdvancePercent || 0);
  const carrierAdvAmt = carrierAdvPct > 0 ? Math.round(price * carrierAdvPct / 100) : 0;

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent className="w-full sm:max-w-lg p-0 overflow-hidden" data-testid="sheet-order-detail">
        <div className="flex flex-col h-full">
          <div className="bg-primary/5 border-b px-6 py-5">
            <SheetHeader className="space-y-3">
              <div className="flex items-center justify-between">
                <SheetTitle className="text-xl font-bold" data-testid="text-detail-load-id">
                  {formatLoadId(order)}
                </SheetTitle>
              </div>
              <SheetDescription className="sr-only">Order details for {formatLoadId(order)}</SheetDescription>
              <div className="flex items-center gap-2 flex-wrap">
                {getStatusBadge(order.status)}
                <Badge variant="outline" className="text-xs bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400">
                  Direct Assignment
                </Badge>
                {order.pickupId && (
                  <Badge variant="outline" className="font-mono text-xs">
                    Pickup ID: {order.pickupId}
                  </Badge>
                )}
              </div>
            </SheetHeader>
          </div>

          <ScrollArea className="flex-1">
            <div className="px-6 py-4 space-y-5">

              <div className="rounded-lg border bg-card p-4">
                <div className="flex items-center gap-2 mb-3">
                  <MapPin className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold">Route Details</h3>
                </div>
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <div className="flex flex-col items-center pt-1">
                      <CircleDot className="h-4 w-4 text-green-500" />
                      <div className="w-px h-full bg-border min-h-[24px]" />
                    </div>
                    <div className="flex-1 pb-2">
                      <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Pickup</p>
                      <p className="text-sm font-semibold">{order.pickupCity || "---"}</p>
                      {order.pickupAddress && <p className="text-xs text-muted-foreground">{order.pickupAddress}</p>}
                      {order.pickupLocality && <p className="text-xs text-muted-foreground">{order.pickupLocality}</p>}
                      {order.pickupState && <p className="text-xs text-muted-foreground">{order.pickupState}</p>}
                      {order.pickupLandmark && <p className="text-xs text-muted-foreground italic">Near: {order.pickupLandmark}</p>}
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="flex flex-col items-center pt-1">
                      <MapPin className="h-4 w-4 text-red-500" />
                    </div>
                    <div className="flex-1">
                      <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Drop</p>
                      <p className="text-sm font-semibold">{order.dropoffCity || "---"}</p>
                      {order.dropoffAddress && <p className="text-xs text-muted-foreground">{order.dropoffAddress}</p>}
                      {order.dropoffLocality && <p className="text-xs text-muted-foreground">{order.dropoffLocality}</p>}
                      {order.dropoffState && <p className="text-xs text-muted-foreground">{order.dropoffState}</p>}
                      {order.dropoffLandmark && <p className="text-xs text-muted-foreground italic">Near: {order.dropoffLandmark}</p>}
                      {order.dropoffBusinessName && <p className="text-xs text-muted-foreground">Business: {order.dropoffBusinessName}</p>}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border bg-card p-4">
                <div className="flex items-center gap-2 mb-3">
                  <IndianRupee className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold">Pricing</h3>
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between items-center py-2">
                    <span className="text-sm text-muted-foreground">Your Payout</span>
                    <span className="text-lg font-bold text-primary" data-testid="text-detail-price">
                      {price > 0 ? formatCurrency(price) : "---"}
                    </span>
                  </div>
                  {carrierAdvPct > 0 && (
                    <>
                      <Separator className="my-2" />
                      <div className="flex justify-between items-center py-1">
                        <span className="text-sm text-muted-foreground">Carrier Advance ({carrierAdvPct}%)</span>
                        <span className="text-sm font-semibold text-green-600">{formatCurrency(carrierAdvAmt)}</span>
                      </div>
                      <div className="flex justify-between items-center py-1">
                        <span className="text-sm text-muted-foreground">Balance Due</span>
                        <span className="text-sm font-medium">{formatCurrency(price - carrierAdvAmt)}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="rounded-lg border bg-card p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Package className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold">Cargo Details</h3>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <DetailRow icon={Weight} label="Weight" value={order.weight ? `${parseFloat(order.weight)} MT` : null} />
                  <DetailRow icon={Truck} label="Truck Type" value={order.requiredTruckType} />
                  <DetailRow icon={FileText} label="Goods" value={order.goodsToBeCarried} />
                  <DetailRow icon={Hash} label="Material Type" value={order.materialType} />
                </div>
                {order.specialNotes && (
                  <div className="mt-2 p-2 rounded bg-muted/50">
                    <p className="text-xs text-muted-foreground">Special Notes</p>
                    <p className="text-sm">{order.specialNotes}</p>
                  </div>
                )}
              </div>

              <div className="rounded-lg border bg-card p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Calendar className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold">Schedule</h3>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  {order.pickupDate && (
                    <div>
                      <p className="text-xs text-muted-foreground">Pickup Date</p>
                      <p className="text-sm font-medium">{format(new Date(order.pickupDate), "dd MMM yyyy")}</p>
                    </div>
                  )}
                  {order.deliveryDate && (
                    <div>
                      <p className="text-xs text-muted-foreground">Delivery Date</p>
                      <p className="text-sm font-medium">{format(new Date(order.deliveryDate), "dd MMM yyyy")}</p>
                    </div>
                  )}
                  {order.assignedAt && (
                    <div>
                      <p className="text-xs text-muted-foreground">Assigned On</p>
                      <p className="text-sm font-medium">{format(new Date(order.assignedAt), "dd MMM yyyy")}</p>
                    </div>
                  )}
                  {order.assignedBy && (
                    <div>
                      <p className="text-xs text-muted-foreground">Assigned By</p>
                      <p className="text-sm font-medium">{order.assignedBy}</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-lg border bg-card p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Building2 className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold">Shipper Info</h3>
                </div>
                <div className="space-y-1">
                  <DetailRow icon={Building2} label="Company" value={order.shipperName} />
                  <DetailRow icon={Phone} label="Phone" value={order.shipperPhone} />
                  {order.shipperContactName && (
                    <DetailRow icon={User} label="Contact Person" value={order.shipperContactName} />
                  )}
                </div>
              </div>

              {(order.receiverName || order.receiverPhone || order.receiverEmail) && (
                <div className="rounded-lg border bg-card p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <User className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-semibold">Receiver Details</h3>
                  </div>
                  <div className="space-y-1">
                    <DetailRow icon={User} label="Name" value={order.receiverName} />
                    <DetailRow icon={Phone} label="Phone" value={order.receiverPhone} />
                    {order.receiverEmail && (
                      <DetailRow label="Email" value={order.receiverEmail} />
                    )}
                  </div>
                </div>
              )}

              {order.shipmentId && (
                <div className="rounded-lg border bg-card p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Info className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-semibold">Shipment Info</h3>
                  </div>
                  <div className="space-y-1">
                    <DetailRow icon={Hash} label="Shipment ID" value={formatShipmentId(order.shipmentId)} />
                    {order.shipmentStatus && (
                      <div className="flex items-start gap-3 py-2">
                        <CircleDot className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                        <div>
                          <p className="text-xs text-muted-foreground">Shipment Status</p>
                          {getStatusBadge(order.shipmentStatus)}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function CarrierMyOrdersPage() {
  const { user, carrierType } = useAuth();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("all");
  const [selectedOrder, setSelectedOrder] = useState<OrderLoad | null>(null);

  const { data: orders = [], isLoading, refetch } = useQuery<OrderLoad[]>({
    queryKey: ["/api/carrier/my-orders"],
  });

  const activeOrders = orders.filter(
    (o) => !["delivered", "closed", "cancelled"].includes(o.status || "")
  );
  const completedOrders = orders.filter(
    (o) => ["delivered", "closed"].includes(o.status || "")
  );
  const cancelledOrders = orders.filter(
    (o) => o.status === "cancelled"
  );

  const totalRevenue = orders
    .filter((o) => ["delivered", "closed"].includes(o.status || ""))
    .reduce((sum, o) => sum + parseFloat(o.finalPrice || "0"), 0);

  const filteredOrders = activeTab === "active" ? activeOrders
    : activeTab === "completed" ? completedOrders
    : activeTab === "cancelled" ? cancelledOrders
    : orders;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="loading-orders">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-2 text-muted-foreground">Loading your orders...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6" data-testid="my-orders-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">My Orders</h1>
          <p className="text-muted-foreground">
            Loads directly assigned to you by admin
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            refetch();
            queryClient.invalidateQueries({ queryKey: ["/api/carrier/my-orders"] });
            toast({ title: "Refreshed", description: "Orders list updated." });
          }}
          data-testid="button-refresh-orders"
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card data-testid="stat-total-orders">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <ClipboardList className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Orders</p>
                <p className="text-2xl font-bold">{orders.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="stat-active-orders">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-900/30">
                <Clock className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Active</p>
                <p className="text-2xl font-bold">{activeOrders.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="stat-completed-orders">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-100 dark:bg-green-900/30">
                <CheckCircle className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Completed</p>
                <p className="text-2xl font-bold">{completedOrders.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="stat-total-revenue">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                <DollarSign className="h-5 w-5 text-emerald-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Revenue</p>
                <p className="text-2xl font-bold">{formatCurrency(totalRevenue)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList data-testid="tabs-order-filter">
          <TabsTrigger value="all" data-testid="tab-all">
            All ({orders.length})
          </TabsTrigger>
          <TabsTrigger value="active" data-testid="tab-active">
            Active ({activeOrders.length})
          </TabsTrigger>
          <TabsTrigger value="completed" data-testid="tab-completed">
            Completed ({completedOrders.length})
          </TabsTrigger>
          <TabsTrigger value="cancelled" data-testid="tab-cancelled">
            Cancelled ({cancelledOrders.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="mt-4">
          {filteredOrders.length === 0 ? (
            <EmptyState
              icon={Package}
              title="No orders found"
              description={
                activeTab === "all"
                  ? "No loads have been directly assigned to you yet. Admin can assign loads to you directly."
                  : `No ${activeTab} orders to display.`
              }
            />
          ) : (
            <ScrollArea className="h-[calc(100vh-400px)]">
              <div className="space-y-3">
                {filteredOrders.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    carrierType={carrierType}
                    onClick={() => setSelectedOrder(order)}
                  />
                ))}
              </div>
            </ScrollArea>
          )}
        </TabsContent>
      </Tabs>

      <OrderDetailSheet
        order={selectedOrder}
        open={!!selectedOrder}
        onClose={() => setSelectedOrder(null)}
      />
    </div>
  );
}

function OrderCard({ order, carrierType, onClick }: { order: OrderLoad; carrierType?: "enterprise" | "solo"; onClick: () => void }) {
  const price = parseFloat(order.finalPrice || "0");
  const perTonRate = order.rateType === "per_ton" && order.shipperPricePerTon
    ? parseFloat(order.shipperPricePerTon)
    : null;

  return (
    <Card
      className="hover:shadow-md transition-all cursor-pointer hover:border-primary/30 group"
      data-testid={`card-order-${order.id}`}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
          <div className="flex-1 space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <h3 className="font-semibold text-lg" data-testid={`text-load-id-${order.id}`}>
                {formatLoadId(order)}
              </h3>
              {getStatusBadge(order.status)}
              <Badge variant="outline" className="text-xs bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400">
                Direct Assignment
              </Badge>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              <div className="flex items-start gap-2">
                <MapPin className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Pickup</p>
                  <p className="text-sm font-medium">{order.pickupCity || order.pickupAddress || "---"}</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <MapPin className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Drop</p>
                  <p className="text-sm font-medium">{order.dropoffCity || order.dropoffAddress || "---"}</p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
              {order.shipperName && (
                <span className="flex items-center gap-1">
                  <Package className="h-3.5 w-3.5" />
                  {order.shipperName}
                </span>
              )}
              {order.requiredTruckType && (
                <span className="flex items-center gap-1">
                  <Truck className="h-3.5 w-3.5" />
                  {order.requiredTruckType}
                </span>
              )}
              {order.weight && (
                <span>{parseFloat(order.weight)} MT</span>
              )}
              {order.goodsToBeCarried && (
                <span>{order.goodsToBeCarried}</span>
              )}
              {order.assignedAt && (
                <span className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" />
                  Assigned: {format(new Date(order.assignedAt), "dd MMM yyyy")}
                </span>
              )}
            </div>

            {order.pickupDate && (
              <div className="flex items-center gap-4 text-sm">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Calendar className="h-3.5 w-3.5" />
                  Pickup: {format(new Date(order.pickupDate), "dd MMM yyyy")}
                </span>
                {order.deliveryDate && (
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <ArrowRight className="h-3.5 w-3.5" />
                    Delivery: {format(new Date(order.deliveryDate), "dd MMM yyyy")}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex items-start gap-3">
            <div className="text-right space-y-2 shrink-0">
              <div>
                <p className="text-xs text-muted-foreground">Your Payout</p>
                <p className="text-xl font-bold text-primary" data-testid={`text-price-${order.id}`}>
                  {price > 0 ? formatCurrency(price) : "---"}
                </p>
              </div>
              {order.carrierAdvancePercent && Number(order.carrierAdvancePercent) > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground">Advance ({order.carrierAdvancePercent}%)</p>
                  <p className="text-sm font-medium text-green-600">
                    {formatCurrency(Math.round(price * Number(order.carrierAdvancePercent) / 100))}
                  </p>
                </div>
              )}
              {order.pickupId && (
                <div className="mt-2">
                  <p className="text-xs text-muted-foreground">Pickup ID</p>
                  <Badge variant="outline" className="font-mono text-base">
                    {order.pickupId}
                  </Badge>
                </div>
              )}
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}