import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { 
  FileText, Check, Clock, AlertCircle, Eye, Download, 
  CreditCard, MessageSquare, CheckCircle, XCircle, Loader2,
  ArrowLeftRight, History, ChevronDown, ChevronUp, DollarSign, Building2, Star,
  Truck, User, MapPin, Phone, Award
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { connectMarketplace, disconnectMarketplace, onMarketplaceEvent } from "@/lib/marketplace-socket";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { format } from "date-fns";

interface CounterOffer {
  id: string;
  proposedAmount: number;
  reason: string;
  proposedBy: "shipper" | "admin";
  status: "pending" | "accepted" | "rejected";
  createdAt: Date;
  respondedAt?: Date;
  responseNote?: string;
}

interface LineItem {
  code?: string;
  description: string;
  quantity: number;
  unitPrice?: number;
  rate?: number;
  amount: number;
}

interface CarrierDetails {
  id: string;
  name: string;
  companyName?: string;
  phone?: string;
  carrierType: "solo" | "enterprise";
  tripsCompleted: number;
}

interface DriverDetails {
  id: string;
  name: string;
  phone?: string;
  licenseNumber?: string;
}

interface TruckDetails {
  id: string;
  licensePlate?: string;
  registrationNumber?: string;
  truckType?: string;
  capacity?: string;
  make?: string;
  model?: string;
}

interface Invoice {
  id: string;
  invoiceNumber: string;
  loadId: string;
  shipperLoadNumber?: number | null;
  adminReferenceNumber?: number | null;
  loadRoute?: string;
  pickupCity?: string;
  pickupAddress?: string;
  pickupLocality?: string;
  pickupLandmark?: string;
  dropoffCity?: string;
  dropoffAddress?: string;
  dropoffLocality?: string;
  dropoffLandmark?: string;
  dropoffBusinessName?: string;
  cargoDescription?: string;
  weight?: string;
  loadStatus?: string;
  shipperId: string;
  subtotal: string;
  discountAmount?: string;
  discountReason?: string;
  taxPercent: string;
  taxAmount: string;
  totalAmount: string;
  paymentTerms?: string;
  status: string;
  shipperConfirmed: boolean;
  shipperConfirmedAt: string | null;
  acknowledgedAt?: string | null;
  paidAt?: string | null;
  paidAmount?: string | null;
  paymentMethod?: string | null;
  paymentReference?: string | null;
  lineItems: LineItem[];
  counterOffers?: CounterOffer[];
  dueDate: string;
  createdAt: string;
  notes?: string;
  advancePaymentPercent?: number;
  carrier?: CarrierDetails;
  driver?: DriverDetails;
  truck?: TruckDetails;
}

// Format load ID for display - shows LD-1001 (admin ref) or LD-044 (shipper seq)
function formatLoadId(invoice: { shipperLoadNumber?: number | null; adminReferenceNumber?: number | null; loadId: string }): string {
  if (invoice.adminReferenceNumber) {
    return `LD-${String(invoice.adminReferenceNumber).padStart(3, '0')}`;
  }
  if (invoice.shipperLoadNumber) {
    return `LD-${String(invoice.shipperLoadNumber).padStart(3, '0')}`;
  }
  // Fallback to first 8 chars of loadId UUID
  return invoice.loadId?.slice(0, 8)?.toUpperCase() || "N/A";
}


export default function ShipperInvoicesPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);

  const { data: apiInvoices = [], isLoading, refetch } = useQuery<Invoice[]>({
    queryKey: ["/api/invoices/shipper"],
  });

  useEffect(() => {
    if (user?.id && user?.role === "shipper") {
      connectMarketplace("shipper", user.id);
      console.log("[Shipper Invoices] Connected to marketplace WebSocket");
      
      const unsubInvoice = onMarketplaceEvent("invoice_update", (data) => {
        console.log("[Shipper Invoices] Received invoice_update event:", data);
        if (data.event === "invoice_sent") {
          toast({
            title: "Invoice Update",
            description: `Invoice ${data.invoice?.invoiceNumber || data.invoiceId} has been sent to you. Please review and acknowledge.`,
          });
          refetch();
        }
      });

      return () => {
        unsubInvoice();
        disconnectMarketplace();
      };
    }
  }, [user?.id, user?.role, toast, refetch]);

  const invoices = useMemo(() => {
    return apiInvoices.filter(inv => {
      const loadStatus = inv.loadStatus?.toLowerCase() || "";
      return ["awarded", "finalized", "in_transit", "delivered", "completed"].includes(loadStatus) ||
             inv.status !== "draft";
    });
  }, [apiInvoices]);

  const acknowledgeMutation = useMutation({
    mutationFn: async (invoiceId: string) => {
      return apiRequest("POST", `/api/shipper/invoices/${invoiceId}/acknowledge`, {});
    },
    onSuccess: () => {
      toast({
        title: "Invoice Acknowledged",
        description: "You have acknowledged receipt of this invoice.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/invoices/shipper"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to acknowledge invoice",
        variant: "destructive",
      });
    },
  });

  const formatCurrency = (amount: string | number) => {
    const num = typeof amount === 'string' ? parseFloat(amount) : amount;
    return `Rs. ${num.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  };

  const getStatusBadge = (invoice: Invoice) => {
    const status = invoice.status.toLowerCase();
    
    if (status === 'paid') {
      return <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"><DollarSign className="h-3 w-3 mr-1" />Paid</Badge>;
    }
    if (status === 'invoice_rejected') {
      return <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"><ArrowLeftRight className="h-3 w-3 mr-1" />Counter Pending</Badge>;
    }
    if (status === 'acknowledged') {
      return <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"><Check className="h-3 w-3 mr-1" />Acknowledged</Badge>;
    }
    if (invoice.shipperConfirmed) {
      return <Badge variant="secondary"><Check className="h-3 w-3 mr-1" />Confirmed</Badge>;
    }
    if (status === 'sent') {
      return <Badge variant="outline" className="text-amber-600 border-amber-300"><Clock className="h-3 w-3 mr-1" />Pending Review</Badge>;
    }
    return <Badge variant="outline">{invoice.status}</Badge>;
  };

  const pendingConfirmation = invoices.filter(inv => {
    const status = inv.status.toLowerCase();
    return !inv.shipperConfirmed && status === 'sent';
  });

  const activeInvoices = invoices.filter(inv => {
    const status = inv.status.toLowerCase();
    return (inv.shipperConfirmed || status === 'acknowledged') && 
           status !== 'paid';
  });

  const paidInvoices = invoices.filter(inv => inv.status.toLowerCase() === 'paid');

  const totalPending = invoices
    .filter(i => i.status.toLowerCase() !== 'paid')
    .reduce((sum, i) => sum + parseFloat(i.totalAmount || "0"), 0);

  const totalPaid = paidInvoices.reduce((sum, i) => sum + parseFloat(i.totalAmount || "0"), 0);


  const handleViewDetails = async (invoice: Invoice) => {
    setSelectedInvoice(invoice);
    setHistoryExpanded(false);
    setDetailsOpen(true);
    
    // Track first-time view for admin real-time sync
    if (!invoice.id.startsWith("INV-SHP-")) {
      try {
        await apiRequest("POST", `/api/shipper/invoices/${invoice.id}/view`);
      } catch (error) {
        console.error("Failed to track invoice view:", error);
      }
    }
  };

  const handleDownloadPDF = (invoice: Invoice) => {
    const content = `
INVOICE - ${invoice.invoiceNumber}
========================================
Date: ${formatDate(invoice.createdAt)}
Due Date: ${formatDate(invoice.dueDate)}
Status: ${invoice.status.toUpperCase()}
Route: ${invoice.loadRoute || 'N/A'}

LINE ITEMS:
${invoice.lineItems?.map(item => `- ${item.description}: ${formatCurrency(item.amount)}`).join('\n') || 'No line items'}

----------------------------------------
TOTAL: ${formatCurrency(invoice.totalAmount)}
========================================
${invoice.paymentReference ? `Payment Ref: ${invoice.paymentReference}` : ''}
    `;
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${invoice.invoiceNumber}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    toast({
      title: "Invoice Downloaded",
      description: `${invoice.invoiceNumber} has been downloaded.`,
    });
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-6 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold">{t('memos.title')}</h1>
        <div className="space-y-4">
          {[1, 2, 3].map(i => (
            <Card key={i} className="animate-pulse">
              <CardContent className="h-32" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const renderInvoiceCard = (invoice: Invoice, showActions: boolean = true) => (
    <Card key={invoice.id} data-testid={`card-invoice-${invoice.id}`}>
      <CardContent className="pt-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium" data-testid={`text-invoice-number-${invoice.id}`}>
                {invoice.invoiceNumber}
              </span>
              {getStatusBadge(invoice)}
            </div>
            {invoice.loadRoute && (
              <p className="text-sm font-medium">{invoice.loadRoute}</p>
            )}
            <p className="text-sm text-muted-foreground">
              Created: {formatDate(invoice.createdAt)} | Due: {formatDate(invoice.dueDate)}
            </p>
            {invoice.acknowledgedAt && (
              <p className="text-xs text-muted-foreground">
                Acknowledged: {format(new Date(invoice.acknowledgedAt), "MMM d, yyyy 'at' h:mm a")}
              </p>
            )}
            {invoice.paidAt && (
              <p className="text-xs text-green-600">
                Paid: {format(new Date(invoice.paidAt), "MMM d, yyyy")} | Ref: {invoice.paymentReference}
              </p>
            )}
            {invoice.counterOffers && invoice.counterOffers.length > 0 && (
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs">
                  <History className="h-3 w-3 mr-1" />
                  {invoice.counterOffers.length} Counter Offer(s)
                </Badge>
                {invoice.counterOffers.some(c => c.status === "pending") && (
                  <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-xs">
                    Awaiting Response
                  </Badge>
                )}
              </div>
            )}
          </div>
          
          <div className="text-right space-y-2">
            <div>
              <p className="text-sm text-muted-foreground">Total Amount</p>
              <p className="text-xl font-bold" data-testid={`text-invoice-total-${invoice.id}`}>
                {formatCurrency(invoice.totalAmount)}
              </p>
            </div>
            {showActions && (
              <div className="flex gap-2 flex-wrap justify-end">
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => handleViewDetails(invoice)}
                  data-testid={`button-view-invoice-${invoice.id}`}
                >
                  <Eye className="h-4 w-4 mr-1" />
                  {t('common.details')}
                </Button>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => handleDownloadPDF(invoice)}
                  data-testid={`button-download-invoice-${invoice.id}`}
                >
                  <Download className="h-4 w-4" />
                </Button>
                
                {invoice.status === 'sent' && !invoice.acknowledgedAt && (
                  <Button 
                    size="sm"
                    onClick={() => acknowledgeMutation.mutate(invoice.id)}
                    disabled={acknowledgeMutation.isPending}
                    data-testid={`button-acknowledge-invoice-${invoice.id}`}
                  >
                    <Check className="h-4 w-4 mr-1" />
                    {t('invoices.acknowledge')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold" data-testid="text-memos-title">{t('memos.title')}</h1>
        <p className="text-muted-foreground">{t('memos.viewMemos')}</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
                <FileText className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t('common.total')} {t('memos.title')}</p>
                <p className="text-xl font-bold">{invoices.length}</p>
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
                <p className="text-sm text-muted-foreground">{t('common.pending')}</p>
                <p className="text-xl font-bold">{formatCurrency(totalPending)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100 dark:bg-green-900/30">
                <DollarSign className="h-5 w-5 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t('invoices.paid')}</p>
                <p className="text-xl font-bold">{formatCurrency(totalPaid)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
                <Check className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t('invoices.acknowledged')}</p>
                <p className="text-xl font-bold">{activeInvoices.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="pending" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="pending" data-testid="tab-pending">
            {t('invoices.pendingPayment')} ({pendingConfirmation.length})
          </TabsTrigger>
          <TabsTrigger value="active" data-testid="tab-active">
            {t('invoices.acknowledged')} ({activeInvoices.length})
          </TabsTrigger>
          <TabsTrigger value="paid" data-testid="tab-paid">
            {t('invoices.paid')} ({paidInvoices.length})
          </TabsTrigger>
        </TabsList>
        
        <TabsContent value="pending" className="space-y-4 mt-4">
          {pendingConfirmation.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <CheckCircle className="h-12 w-12 mx-auto text-green-500 mb-4" />
                <h3 className="text-lg font-semibold">{t('messages.success')}</h3>
                <p className="text-muted-foreground">{t('memos.noMemosFound')}</p>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
                <AlertCircle className="h-4 w-4" />
                <span>{t('invoices.pendingPayment')}</span>
              </div>
              {pendingConfirmation.map(invoice => renderInvoiceCard(invoice))}
            </>
          )}
        </TabsContent>
        
        <TabsContent value="active" className="space-y-4 mt-4">
          {activeInvoices.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <FileText className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                <p className="text-muted-foreground">{t('memos.noMemosFound')}</p>
              </CardContent>
            </Card>
          ) : (
            activeInvoices.map(invoice => renderInvoiceCard(invoice))
          )}
        </TabsContent>
        
        <TabsContent value="paid" className="space-y-4 mt-4">
          {paidInvoices.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <DollarSign className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                <p className="text-muted-foreground">{t('memos.noMemosFound')}</p>
              </CardContent>
            </Card>
          ) : (
            paidInvoices.map(invoice => renderInvoiceCard(invoice, false))
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              {selectedInvoice?.invoiceNumber}
            </DialogTitle>
            <DialogDescription>
              {t('invoices.invoiceDetails')}
            </DialogDescription>
          </DialogHeader>
          {selectedInvoice && (
            <div className="flex-1 overflow-y-auto pr-2" style={{ maxHeight: 'calc(80vh - 140px)' }}>
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-muted-foreground">{t('invoices.route')}</Label>
                    <p className="font-medium">{selectedInvoice.loadRoute || "N/A"}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">{t('common.status')}</Label>
                    <p className="mt-1">{getStatusBadge(selectedInvoice)}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Load ID</Label>
                    <p className="font-medium font-mono">{formatLoadId(selectedInvoice)}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">{t('invoices.invoiceDate')}</Label>
                    <p className="font-medium">{formatDate(selectedInvoice.createdAt)}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">{t('invoices.dueDate')}</Label>
                    <p className="font-medium">{formatDate(selectedInvoice.dueDate)}</p>
                  </div>
                </div>

                {/* Carrier Details Section */}
                {selectedInvoice.carrier && (
                  <Card className="border-blue-200 dark:border-blue-700/50 bg-blue-50/30 dark:bg-blue-900/10">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        {selectedInvoice.carrier.carrierType === 'solo' ? (
                          <User className="h-4 w-4 text-blue-600" />
                        ) : (
                          <Building2 className="h-4 w-4 text-blue-600" />
                        )}
                        {selectedInvoice.carrier.carrierType === 'solo' ? 'Solo Driver' : 'Enterprise Carrier'}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {selectedInvoice.carrier.carrierType === 'solo' ? (
                        <>
                          {/* Solo Driver Details */}
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <Label className="text-xs text-muted-foreground">Driver Name</Label>
                              <p className="font-medium text-sm" data-testid="text-carrier-name">
                                {selectedInvoice.carrier.name}
                              </p>
                            </div>
                            {selectedInvoice.adminContact?.phone && (
                              <div>
                                <Label className="text-xs text-muted-foreground">Support Contact</Label>
                                <p className="text-sm flex items-center gap-1">
                                  <Phone className="h-3 w-3 text-muted-foreground" />
                                  {selectedInvoice.adminContact.phone}
                                </p>
                              </div>
                            )}
                          </div>
                          {/* Vehicle Information - Consistent with Admin Portal */}
                          {selectedInvoice.truck && (
                            <div className="bg-slate-50 dark:bg-slate-900/30 rounded-lg p-3 space-y-2">
                              <Label className="text-xs text-muted-foreground font-semibold">Vehicle Information</Label>
                              <div className="grid grid-cols-2 gap-3 text-sm">
                                <div>
                                  <span className="text-muted-foreground text-xs">Vehicle Number</span>
                                  <p className="font-semibold font-mono" data-testid="text-truck-number">
                                    {selectedInvoice.truck.licensePlate || selectedInvoice.truck.registrationNumber || "N/A"}
                                  </p>
                                </div>
                                {selectedInvoice.truck.truckType && (
                                  <div>
                                    <span className="text-muted-foreground text-xs">Truck Type</span>
                                    <p className="font-medium">{selectedInvoice.truck.truckType.replace(/_/g, ' ')}</p>
                                  </div>
                                )}
                                {(selectedInvoice.truck.make || selectedInvoice.truck.model) && (
                                  <div>
                                    <span className="text-muted-foreground text-xs">Make / Model</span>
                                    <p className="font-medium">
                                      {selectedInvoice.truck.make || ''} {selectedInvoice.truck.model || ''}
                                    </p>
                                  </div>
                                )}
                                {selectedInvoice.truck.capacity && (
                                  <div>
                                    <span className="text-muted-foreground text-xs">Capacity</span>
                                    <p className="font-medium">{selectedInvoice.truck.capacity} MT</p>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                          {/* Trips Completed */}
                          <div className="flex items-center gap-2 text-xs bg-green-50 dark:bg-green-900/20 rounded p-2">
                            <Award className="h-3 w-3 text-green-600" />
                            <span className="text-green-700 dark:text-green-400 font-medium" data-testid="text-trips-completed">
                              {selectedInvoice.carrier.tripsCompleted} trips completed
                            </span>
                          </div>
                        </>
                      ) : (
                        <>
                          {/* Enterprise Carrier Details */}
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <Label className="text-xs text-muted-foreground">Company Name</Label>
                              <p className="font-medium text-sm" data-testid="text-company-name">
                                {selectedInvoice.carrier.companyName || selectedInvoice.carrier.name}
                              </p>
                            </div>
                            {selectedInvoice.driver && (
                              <div>
                                <Label className="text-xs text-muted-foreground">Assigned Driver</Label>
                                <p className="font-medium text-sm flex items-center gap-1" data-testid="text-driver-name">
                                  <User className="h-3 w-3 text-muted-foreground" />
                                  {selectedInvoice.driver.name}
                                </p>
                              </div>
                            )}
                          </div>
                          {selectedInvoice.adminContact?.phone && (
                            <div className="bg-background/50 rounded-md p-2">
                              <Label className="text-xs text-muted-foreground">Support Contact</Label>
                              <div className="flex items-center gap-1 mt-1">
                                <Phone className="h-3 w-3 text-muted-foreground" />
                                <p className="text-sm">{selectedInvoice.adminContact.phone}</p>
                              </div>
                            </div>
                          )}
                          {/* Vehicle Information - Consistent with Admin Portal */}
                          {selectedInvoice.truck && (
                            <div className="bg-slate-50 dark:bg-slate-900/30 rounded-lg p-3 space-y-2">
                              <Label className="text-xs text-muted-foreground font-semibold">Vehicle Information</Label>
                              <div className="grid grid-cols-2 gap-3 text-sm">
                                <div>
                                  <span className="text-muted-foreground text-xs">Vehicle Number</span>
                                  <p className="font-semibold font-mono" data-testid="text-truck-number">
                                    {selectedInvoice.truck.licensePlate || selectedInvoice.truck.registrationNumber || "N/A"}
                                  </p>
                                </div>
                                {selectedInvoice.truck.truckType && (
                                  <div>
                                    <span className="text-muted-foreground text-xs">Truck Type</span>
                                    <p className="font-medium">{selectedInvoice.truck.truckType.replace(/_/g, ' ')}</p>
                                  </div>
                                )}
                                {(selectedInvoice.truck.make || selectedInvoice.truck.model) && (
                                  <div>
                                    <span className="text-muted-foreground text-xs">Make / Model</span>
                                    <p className="font-medium">
                                      {selectedInvoice.truck.make || ''} {selectedInvoice.truck.model || ''}
                                    </p>
                                  </div>
                                )}
                                {selectedInvoice.truck.capacity && (
                                  <div>
                                    <span className="text-muted-foreground text-xs">Capacity</span>
                                    <p className="font-medium">{selectedInvoice.truck.capacity} MT</p>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                          {/* Trips Completed */}
                          <div className="flex items-center gap-2 text-xs bg-green-50 dark:bg-green-900/20 rounded p-2">
                            <Award className="h-3 w-3 text-green-600" />
                            <span className="text-green-700 dark:text-green-400 font-medium" data-testid="text-trips-completed">
                              {selectedInvoice.carrier.tripsCompleted} trips completed
                            </span>
                          </div>
                        </>
                      )}
                      
                      {/* Route Display - Full Details */}
                      {selectedInvoice.pickupCity && selectedInvoice.dropoffCity && (
                        <div className="pt-2 border-t space-y-3">
                          <Label className="text-xs text-muted-foreground">Route Details</Label>
                          <div className="grid grid-cols-2 gap-4">
                            {/* Pickup Location */}
                            <div className="space-y-1">
                              <div className="flex items-center gap-1 text-xs text-green-600 font-medium">
                                <MapPin className="h-3 w-3" />
                                Pickup
                              </div>
                              <p className="font-medium text-sm">{selectedInvoice.pickupCity}</p>
                              {selectedInvoice.pickupLocality && (
                                <p className="text-xs text-muted-foreground">{selectedInvoice.pickupLocality}</p>
                              )}
                              {selectedInvoice.pickupAddress && (
                                <p className="text-xs text-muted-foreground">{selectedInvoice.pickupAddress}</p>
                              )}
                              {selectedInvoice.pickupLandmark && (
                                <p className="text-xs text-muted-foreground">Near: {selectedInvoice.pickupLandmark}</p>
                              )}
                            </div>
                            {/* Dropoff Location */}
                            <div className="space-y-1">
                              <div className="flex items-center gap-1 text-xs text-red-600 font-medium">
                                <MapPin className="h-3 w-3" />
                                Dropoff
                              </div>
                              <p className="font-medium text-sm">{selectedInvoice.dropoffCity}</p>
                              {selectedInvoice.dropoffBusinessName && (
                                <p className="text-xs font-medium">{selectedInvoice.dropoffBusinessName}</p>
                              )}
                              {selectedInvoice.dropoffLocality && (
                                <p className="text-xs text-muted-foreground">{selectedInvoice.dropoffLocality}</p>
                              )}
                              {selectedInvoice.dropoffAddress && (
                                <p className="text-xs text-muted-foreground">{selectedInvoice.dropoffAddress}</p>
                              )}
                              {selectedInvoice.dropoffLandmark && (
                                <p className="text-xs text-muted-foreground">Near: {selectedInvoice.dropoffLandmark}</p>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                      
                      {/* Commodity & Weight */}
                      <div className="pt-2 border-t flex items-center gap-4 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">Commodity:</span>
                          <span className="font-medium">{selectedInvoice.cargoDescription || "N/A"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">Weight:</span>
                          <span className="font-medium">{selectedInvoice.weight || "N/A"}</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">{t('invoices.invoiceDetails')}</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-3">
                    <div className="flex justify-between text-lg font-bold">
                      <span>{t('invoices.grandTotal')}</span>
                      <span>{formatCurrency(selectedInvoice.totalAmount)}</span>
                    </div>
                    {selectedInvoice.advancePaymentPercent !== undefined && selectedInvoice.advancePaymentPercent !== null && selectedInvoice.advancePaymentPercent > 0 && (
                      <>
                        <Separator />
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">{t('invoices.advance')}</span>
                          <span className="font-semibold text-green-600 dark:text-green-400">
                            {selectedInvoice.advancePaymentPercent}%
                          </span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">{t('invoices.balance')}</span>
                          <span className="font-medium">
                            {100 - selectedInvoice.advancePaymentPercent}%
                          </span>
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
                
                {/* Thank You Message */}
                <p className="text-center text-lg font-semibold text-primary">
                  Thank you for your business.
                </p>
                
                {/* Payment Instructions */}
                <Card className="border-blue-200 dark:border-blue-700/50 bg-blue-50/50 dark:bg-blue-900/10">
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <CreditCard className="h-4 w-4 text-blue-600" />
                      {t('invoices.bankDetails')}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-3 text-sm">
                    <div className="grid gap-2">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Bank Name:</span>
                        <span className="font-medium">HDFC Bank</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Account Name:</span>
                        <span className="font-medium">Load Smart Logistics Pvt Ltd</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Account Number:</span>
                        <span className="font-mono font-medium">XXXX XXXX XXXX 1234</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">IFSC Code:</span>
                        <span className="font-mono font-medium">HDFC0001234</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">UPI ID:</span>
                        <span className="font-mono font-medium">freightflow@hdfcbank</span>
                      </div>
                    </div>
                    <p className="text-base font-medium pt-2 border-t">
                      Please include your final Invoice Number as payment reference upon delivery.
                    </p>
                  </CardContent>
                </Card>

                {selectedInvoice.acknowledgedAt && (
                  <Card>
                    <CardContent className="pt-4">
                      <div className="flex items-center gap-2 text-blue-600">
                        <Check className="h-4 w-4" />
                        <span className="text-sm">Acknowledged on {format(new Date(selectedInvoice.acknowledgedAt), "MMM d, yyyy 'at' h:mm a")}</span>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {selectedInvoice.paidAt && (
                  <Card>
                    <CardContent className="pt-4">
                      <div className="flex items-center gap-2 text-green-600">
                        <DollarSign className="h-4 w-4" />
                        <span className="text-sm">
                          Paid on {format(new Date(selectedInvoice.paidAt), "MMM d, yyyy")} via {selectedInvoice.paymentMethod?.replace('_', ' ')}
                        </span>
                      </div>
                      {selectedInvoice.paymentReference && (
                        <p className="text-xs text-muted-foreground mt-1">Reference: {selectedInvoice.paymentReference}</p>
                      )}
                    </CardContent>
                  </Card>
                )}

                {selectedInvoice.counterOffers && selectedInvoice.counterOffers.length > 0 && (
                  <Collapsible open={historyExpanded} onOpenChange={setHistoryExpanded}>
                    <Card>
                      <CollapsibleTrigger asChild>
                        <CardHeader className="py-3 cursor-pointer hover-elevate">
                          <div className="flex items-center justify-between">
                            <CardTitle className="text-sm flex items-center gap-2">
                              <History className="h-4 w-4" />
                              Counter Offer History ({selectedInvoice.counterOffers.length})
                            </CardTitle>
                            {historyExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </div>
                        </CardHeader>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <CardContent className="pt-0 space-y-4">
                          {selectedInvoice.counterOffers.map((offer, index) => (
                            <div key={offer.id} className="border rounded-lg p-4 space-y-3">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <Badge variant="outline">Counter #{index + 1}</Badge>
                                  {offer.status === "pending" && (
                                    <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                                      <Clock className="h-3 w-3 mr-1" />Pending
                                    </Badge>
                                  )}
                                  {offer.status === "accepted" && (
                                    <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                                      <CheckCircle className="h-3 w-3 mr-1" />Accepted
                                    </Badge>
                                  )}
                                  {offer.status === "rejected" && (
                                    <Badge variant="destructive">
                                      <XCircle className="h-3 w-3 mr-1" />Rejected
                                    </Badge>
                                  )}
                                </div>
                                <span className="text-xs text-muted-foreground">
                                  {format(new Date(offer.createdAt), "MMM d, yyyy")}
                                </span>
                              </div>
                              <div>
                                <p className="text-sm text-muted-foreground">Your Proposed Amount</p>
                                <p className="font-semibold text-lg">{formatCurrency(offer.proposedAmount)}</p>
                              </div>
                              <div>
                                <p className="text-sm text-muted-foreground">Your Reason</p>
                                <p className="text-sm bg-muted/50 p-2 rounded">{offer.reason}</p>
                              </div>
                              {offer.responseNote && (
                                <div>
                                  <p className="text-sm text-muted-foreground">Admin Response</p>
                                  <p className="text-sm bg-primary/5 p-2 rounded">{offer.responseNote}</p>
                                </div>
                              )}
                            </div>
                          ))}
                        </CardContent>
                      </CollapsibleContent>
                    </Card>
                  </Collapsible>
                )}
              </div>
            </div>
          )}
          <DialogFooter className="flex-shrink-0 border-t pt-4">
            <Button variant="outline" onClick={() => setDetailsOpen(false)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


    </div>
  );
}
