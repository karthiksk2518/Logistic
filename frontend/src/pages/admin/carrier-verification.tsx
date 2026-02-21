import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { 
  Truck, Search, FileText, ChevronLeft, Eye, ExternalLink,
  ShieldCheck, ShieldX, ShieldAlert, Clock, CreditCard,
  CheckCircle, XCircle, User, Building2, MapPin, Phone,
  ChevronDown, Info, Image, FileType, Ruler, PauseCircle
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { format } from "date-fns";

// Document Requirements for Solo Operators
const SOLO_DOCUMENT_REQUIREMENTS = [
  { type: "aadhaar_card", name: "Aadhaar Card", formats: "JPG / PNG / PDF" },
  { type: "driver_license", name: "Driver License", formats: "JPG / PNG / PDF" },
  { type: "pan_card", name: "PAN Card", formats: "JPG / PNG / PDF" },
  { type: "permit_document", name: "Permit Document (National/Domestic)", formats: "JPG / PNG / PDF" },
  { type: "rc", name: "RC (Registration Certificate)", formats: "JPG / PNG / PDF" },
  { type: "insurance_certificate", name: "Insurance Certificate", formats: "JPG / PNG / PDF" },
  { type: "fitness_certificate", name: "Fitness Certificate", formats: "PDF / JPG" },
];

// Document Requirements for Fleet/Company Carriers
const ENTERPRISE_DOCUMENT_REQUIREMENTS = [
  { type: "incorporation_certificate", name: "Incorporation Certificate", formats: "PDF / JPG" },
  { type: "trade_license", name: "Trade License / Business Registration", formats: "PDF / JPG" },
  { type: "address_proof", name: "Business Address Proof", formats: "PDF / JPG" },
  { type: "pan_card", name: "PAN Card", formats: "JPG / PNG / PDF" },
  { type: "gstin_certificate", name: "GSTIN Certificate", formats: "PDF / JPG" },
  { type: "tan_certificate", name: "TAN Certificate", formats: "PDF / JPG" },
];

// Complete document type labels for all supported types
const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  rc: "RC (Registration Certificate)",
  insurance: "Vehicle Insurance",
  fitness: "Fitness Certificate",
  permit: "National / State Permit",
  puc: "PUC Certificate",
  road_tax: "Road Tax / Challan Clearance",
  license: "Driving License",
  pan: "PAN Card",
  gst: "GST Certificate",
  aadhar: "Aadhaar Card",
  aadhaar: "Aadhaar Card",
  fleet_proof: "Fleet Ownership Proof",
  aadhaar_card: "Aadhaar Card",
  driver_license: "Driver License",
  permit_document: "Permit Document",
  insurance_certificate: "Insurance Certificate",
  fitness_certificate: "Fitness Certificate",
  incorporation_certificate: "Incorporation Certificate",
  trade_license: "Trade License",
  address_proof: "Business Address Proof",
  address_proof_rent_agreement: "Address Proof (Rent Agreement)",
  address_proof_electricity_bill: "Address Proof (Electricity Bill)",
  address_proof_office_photo: "Address Proof (Office Photo with Board)",
  pan_card: "PAN Card",
  gstin_certificate: "GSTIN Certificate",
  tan_certificate: "TAN Certificate",
  tds_declaration: "TDS Declaration",
  cin: "CIN Certificate",
  selfie: "Selfie",
  msme_udyam: "MSME / Udyam Certificate",
  msme: "MSME / Udyam Certificate",
  udyam: "MSME / Udyam Certificate",
  void_cheque: "Void Cheque / Cancelled Cheque",
};

// Helper to get document display name
const getDocumentDisplayName = (type: string) => {
  return DOCUMENT_TYPE_LABELS[type] || type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
};

// Document priority order for display (lower number = higher priority)
const DOCUMENT_PRIORITY: Record<string, number> = {
  // Solo operator documents - identity first
  aadhaar: 1,
  aadhar: 1,
  aadhaar_card: 1,
  license: 2,
  driver_license: 2,
  permit: 3,
  permit_document: 3,
  rc: 4,
  insurance: 5,
  insurance_certificate: 5,
  fitness: 6,
  fitness_certificate: 6,
  // Fleet/Company documents
  incorporation: 10,
  incorporation_certificate: 10,
  trade_license: 11,
  address_proof: 12,
  address_proof_rent_agreement: 12,
  address_proof_electricity_bill: 12,
  address_proof_office_photo: 12,
  pan: 13,
  pan_card: 13,
  gstin: 14,
  gstin_certificate: 14,
  gst: 14,
  tan: 15,
  tan_certificate: 15,
  tds_declaration: 16,
  fleet_proof: 17,
  other: 99,
};

// Sort documents by priority
const sortDocumentsByPriority = (docs: VerificationDocument[]) => {
  return [...docs].sort((a, b) => {
    const priorityA = DOCUMENT_PRIORITY[a.documentType] ?? 50;
    const priorityB = DOCUMENT_PRIORITY[b.documentType] ?? 50;
    return priorityA - priorityB;
  });
};

interface CarrierVerification {
  id: string;
  carrierId: string;
  carrierType: "solo" | "enterprise";
  fleetSize: number;
  status: "draft" | "pending" | "under_review" | "approved" | "rejected" | "on_hold";
  notes?: string;
  rejectionReason?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  createdAt: string;
  submittedAt?: string;
  carrier?: {
    id: string;
    username: string;
    companyName: string;
    email: string;
    phone?: string;
    serviceZones?: string[];
  };
  documents?: VerificationDocument[];
  aadhaarNumber?: string;
  driverLicenseNumber?: string;
  permitType?: "national" | "domestic";
  uniqueRegistrationNumber?: string;
  chassisNumber?: string;
  licensePlateNumber?: string;
  incorporationType?: "pvt_ltd" | "llp" | "proprietorship" | "partnership";
  businessType?: string;
  cinNumber?: string;
  partnerName?: string;
  businessRegistrationNumber?: string;
  businessAddress?: string;
  businessLocality?: string;
  panNumber?: string;
  gstinNumber?: string;
  tanNumber?: string;
  // Address proof
  addressProofType?: string;
  // Bank details
  bankName?: string;
  bankAccountNumber?: string;
  bankIfscCode?: string;
  bankAccountHolderName?: string;
}

interface VerificationDocument {
  id: string;
  documentType: string;
  fileName: string;
  fileUrl: string;
  uploadedAt: string;
  status?: "pending" | "approved" | "rejected";
}

export default function CarrierVerificationPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState("pending");
  const [selectedVerification, setSelectedVerification] = useState<CarrierVerification | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [holdDialogOpen, setHoldDialogOpen] = useState(false);
  const [holdNotes, setHoldNotes] = useState("");
  const [requirementsOpen, setRequirementsOpen] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<VerificationDocument | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const { data: verifications = [], isLoading, refetch } = useQuery<CarrierVerification[]>({
    queryKey: ["/api/admin/verifications"],
  });

  const approveMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("POST", `/api/admin/verifications/${id}/approve`, {});
    },
    onSuccess: () => {
      // Invalidate all related queries for consistent data across portal
      queryClient.invalidateQueries({ queryKey: ["/api/admin/verifications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/carriers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/carriers"] }); // Update dashboard
      toast({
        title: "Carrier Verified",
        description: "The carrier has been verified and added to the directory.",
      });
      setDetailsOpen(false);
      setSelectedVerification(null);
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to approve verification",
      });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      return apiRequest("POST", `/api/admin/verifications/${id}/reject`, { reason });
    },
    onSuccess: () => {
      // Invalidate all related queries for consistent data across portal
      queryClient.invalidateQueries({ queryKey: ["/api/admin/verifications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/carriers"] }); // Update dashboard
      toast({
        title: "Verification Rejected",
        description: "The carrier verification has been rejected.",
      });
      setRejectDialogOpen(false);
      setDetailsOpen(false);
      setSelectedVerification(null);
      setRejectReason("");
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to reject verification",
      });
    },
  });

  const holdMutation = useMutation({
    mutationFn: async ({ id, notes }: { id: string; notes: string }) => {
      return apiRequest("POST", `/api/admin/verifications/${id}/hold`, { notes });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/verifications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/carriers"] });
      toast({
        title: "Verification On Hold",
        description: "The carrier verification has been put on hold.",
      });
      setHoldDialogOpen(false);
      setDetailsOpen(false);
      setSelectedVerification(null);
      setHoldNotes("");
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to put verification on hold",
      });
    },
  });

  // Individual document verification mutation
  const documentVerifyMutation = useMutation({
    mutationFn: async ({ docId, status, rejectionReason }: { docId: string; status: "approved" | "rejected"; rejectionReason?: string }) => {
      return apiRequest("PATCH", `/api/admin/verification-documents/${docId}`, { status, rejectionReason });
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/verifications"] });
      toast({
        title: variables.status === "approved" ? "Document Approved" : "Document Rejected",
        description: variables.status === "approved" 
          ? "The document has been verified successfully." 
          : "The carrier has been notified of the rejection.",
      });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to update document status",
      });
    },
  });

  // State for document rejection dialog
  const [docRejectDialogOpen, setDocRejectDialogOpen] = useState(false);
  const [docRejectReason, setDocRejectReason] = useState("");
  const [selectedDocForReject, setSelectedDocForReject] = useState<VerificationDocument | null>(null);

  const handleDocApprove = (doc: VerificationDocument) => {
    documentVerifyMutation.mutate({ docId: doc.id, status: "approved" });
  };

  const handleDocReject = () => {
    if (selectedDocForReject && docRejectReason.trim()) {
      documentVerifyMutation.mutate({ 
        docId: selectedDocForReject.id, 
        status: "rejected", 
        rejectionReason: docRejectReason 
      });
      setDocRejectDialogOpen(false);
      setDocRejectReason("");
      setSelectedDocForReject(null);
    }
  };

  // Sort function: latest (most recent) first
  const sortByLatestFirst = (list: CarrierVerification[]) => {
    return [...list].sort((a, b) => {
      const dateA = new Date(a.submittedAt || a.createdAt).getTime();
      const dateB = new Date(b.submittedAt || b.createdAt).getTime();
      return dateB - dateA; // Descending order (latest first)
    });
  };

  const pendingVerifications = useMemo(() => {
    const pending = verifications.filter(v => v.status === "pending" || v.status === "under_review");
    return sortByLatestFirst(pending);
  }, [verifications]);

  // Categorized pending verifications
  const pendingSoloVerifications = useMemo(() => {
    return pendingVerifications.filter(v => v.carrierType === "solo" || (!v.carrierType && v.fleetSize === 1));
  }, [pendingVerifications]);

  const pendingFleetVerifications = useMemo(() => {
    return pendingVerifications.filter(v => v.carrierType === "enterprise" || (!v.carrierType && v.fleetSize > 1));
  }, [pendingVerifications]);

  const draftVerifications = useMemo(() => {
    const drafts = verifications.filter(v => v.status === "draft");
    return sortByLatestFirst(drafts);
  }, [verifications]);

  const rejectedVerifications = useMemo(() => {
    const rejected = verifications.filter(v => v.status === "rejected" || v.status === "on_hold");
    return sortByLatestFirst(rejected);
  }, [verifications]);

  // Search filter function
  const filterBySearch = (list: CarrierVerification[]) => {
    if (!searchQuery) return list;
    const query = searchQuery.toLowerCase();
    return list.filter(v => 
      v.carrier?.companyName?.toLowerCase().includes(query) ||
      v.carrier?.email?.toLowerCase().includes(query)
    );
  };

  const filteredVerifications = useMemo(() => {
    const list = activeTab === "pending" ? pendingVerifications : 
                 activeTab === "draft" ? draftVerifications : rejectedVerifications;
    return filterBySearch(list);
  }, [activeTab, pendingVerifications, draftVerifications, rejectedVerifications, searchQuery]);

  // Filtered categorized pending lists for display
  const filteredPendingSolo = useMemo(() => filterBySearch(pendingSoloVerifications), [pendingSoloVerifications, searchQuery]);
  const filteredPendingFleet = useMemo(() => filterBySearch(pendingFleetVerifications), [pendingFleetVerifications, searchQuery]);

  const handleApprove = (verification: CarrierVerification) => {
    approveMutation.mutate(verification.id);
  };

  const handleReject = () => {
    if (selectedVerification && rejectReason.trim()) {
      rejectMutation.mutate({ id: selectedVerification.id, reason: rejectReason });
    }
  };

  const handleHold = () => {
    if (selectedVerification && holdNotes.trim()) {
      holdMutation.mutate({ id: selectedVerification.id, notes: holdNotes });
    }
  };

  const openDetails = (verification: CarrierVerification) => {
    setSelectedVerification(verification);
    setDetailsOpen(true);
  };

  const getCarrierTypeDisplay = (verification: CarrierVerification) => {
    // Prioritize explicit carrierType from database over fleet size
    if (verification.carrierType === "solo") {
      return { label: "Solo Owner-Operator", icon: User, color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" };
    }
    // Enterprise/fleet carriers show as Fleet regardless of fleet size
    if (verification.carrierType === "enterprise") {
      return { label: `Fleet (${verification.fleetSize} truck${verification.fleetSize !== 1 ? 's' : ''})`, icon: Building2, color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" };
    }
    // Fallback for legacy data without explicit carrierType
    if (verification.fleetSize === 1) {
      return { label: "Solo Owner-Operator", icon: User, color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" };
    }
    return { label: `Fleet (${verification.fleetSize} trucks)`, icon: Building2, color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" };
  };

  const renderVerificationCard = (verification: CarrierVerification) => {
    const carrierType = getCarrierTypeDisplay(verification);
    const CarrierIcon = carrierType.icon;
    const documents = verification.documents || [];

    return (
      <Card key={verification.id} className="hover-elevate" data-testid={`verification-card-${verification.id}`}>
        <CardContent className="p-5">
          <div className="flex flex-col lg:flex-row lg:items-start gap-4">
            <div className="flex-1 space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                  <Truck className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <h3 className="font-semibold" data-testid={`text-carrier-name-${verification.id}`}>
                    {verification.carrier?.companyName || "Unknown Carrier"}
                  </h3>
                  <p className="text-sm text-muted-foreground">{verification.carrier?.email}</p>
                </div>
                <Badge className={`${carrierType.color} no-default-hover-elevate no-default-active-elevate`}>
                  <CarrierIcon className="h-3 w-3 mr-1" />
                  {carrierType.label}
                </Badge>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Phone className="h-4 w-4" />
                  <span>{verification.carrier?.phone || "Not provided"}</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <MapPin className="h-4 w-4" />
                  <span>{verification.carrier?.serviceZones?.slice(0, 2).join(", ") || "Not specified"}</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Truck className="h-4 w-4" />
                  <span>{verification.fleetSize} truck(s)</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  <span>Applied {format(new Date(verification.submittedAt || verification.createdAt), "MMM d, yyyy")}</span>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="gap-1">
                  <FileText className="h-3 w-3" />
                  {documents.length} Documents
                </Badge>
                {verification.status === "rejected" && verification.rejectionReason && (
                  <Badge variant="destructive" className="gap-1">
                    <XCircle className="h-3 w-3" />
                    Rejected: {verification.rejectionReason}
                  </Badge>
                )}
                {verification.status === "on_hold" && verification.notes && (
                  <Badge variant="secondary" className="gap-1">
                    <PauseCircle className="h-3 w-3" />
                    On Hold: {verification.notes}
                  </Badge>
                )}
              </div>
            </div>

            <div className="flex gap-2">
              <Button 
                variant="outline" 
                onClick={() => openDetails(verification)}
                data-testid={`button-view-details-${verification.id}`}
              >
                <Eye className="h-4 w-4 mr-2" />
                Review
              </Button>
              {verification.status === "pending" && (
                <>
                  <Button 
                    onClick={() => handleApprove(verification)}
                    disabled={approveMutation.isPending}
                    data-testid={`button-quick-approve-${verification.id}`}
                  >
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Approve
                  </Button>
                  <Button 
                    variant="destructive"
                    onClick={() => {
                      setSelectedVerification(verification);
                      setRejectDialogOpen(true);
                    }}
                    data-testid={`button-quick-reject-${verification.id}`}
                  >
                    <XCircle className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-10 w-full" />
        <div className="space-y-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Button 
            variant="ghost" 
            size="icon"
            onClick={() => setLocation("/admin")}
            data-testid="button-back"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">Carrier Verification</h1>
            <p className="text-muted-foreground">Review and verify carrier applications with documents</p>
          </div>
        </div>
        <Button 
          variant="secondary"
          onClick={async () => {
            try {
              const res = await fetch("/api/admin/seed-pending-verifications", { method: "POST", credentials: "include" });
              const data = await res.json();
              if (res.ok) {
                toast({
                  title: "Pending Verifications Seeded",
                  description: `Created ${data.carriers?.length || 0} pending carrier verification requests.`,
                });
                refetch();
              } else {
                toast({
                  title: "Seed Failed",
                  description: data.error || "Failed to seed pending verifications",
                  variant: "destructive",
                });
              }
            } catch (e) {
              console.error("Seed error:", e);
              toast({
                title: "Error",
                description: "Failed to seed pending verifications.",
                variant: "destructive",
              });
            }
          }}
          data-testid="button-seed-pending"
        >
          <ShieldAlert className="h-4 w-4 mr-2" />
          Seed Pending
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/30">
                <Clock className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Pending Review</p>
                <p className="text-2xl font-bold" data-testid="stat-pending">{pendingVerifications.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-100 dark:bg-red-900/30">
                <ShieldX className="h-5 w-5 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Rejected</p>
                <p className="text-2xl font-bold" data-testid="stat-rejected">{rejectedVerifications.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100 dark:bg-green-900/30">
                <ShieldCheck className="h-5 w-5 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Verified</p>
                <p className="text-2xl font-bold" data-testid="stat-verified-today">
                  {verifications.filter(v => v.status === "approved").length}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Document Requirements Reference */}
      <Collapsible open={requirementsOpen} onOpenChange={setRequirementsOpen}>
        <Card>
          <CollapsibleTrigger className="w-full">
            <CardHeader className="py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Info className="h-4 w-4 text-blue-600" />
                  <CardTitle className="text-sm font-medium">Document Requirements Reference</CardTitle>
                </div>
                <ChevronDown className={`h-4 w-4 transition-transform ${requirementsOpen ? "rotate-180" : ""}`} />
              </div>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="pt-0 space-y-4">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <User className="h-4 w-4 text-blue-600" />
                  <span className="font-medium text-sm">Solo Operator Documents</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 px-3 font-medium">Document Type</th>
                        <th className="text-left py-2 px-3 font-medium">
                          <div className="flex items-center gap-1">
                            <FileType className="h-3 w-3" /> Formats
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {SOLO_DOCUMENT_REQUIREMENTS.map((doc) => (
                        <tr key={doc.type} className="border-b last:border-0">
                          <td className="py-2 px-3 font-medium">{doc.name}</td>
                          <td className="py-2 px-3">
                            <Badge variant="secondary" className="text-xs">{doc.formats}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Building2 className="h-4 w-4 text-purple-600" />
                  <span className="font-medium text-sm">Fleet/Company Documents</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 px-3 font-medium">Document Type</th>
                        <th className="text-left py-2 px-3 font-medium">
                          <div className="flex items-center gap-1">
                            <FileType className="h-3 w-3" /> Formats
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {ENTERPRISE_DOCUMENT_REQUIREMENTS.map((doc) => (
                        <tr key={doc.type} className="border-b last:border-0">
                          <td className="py-2 px-3 font-medium">{doc.name}</td>
                          <td className="py-2 px-3">
                            <Badge variant="secondary" className="text-xs">{doc.formats}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by company name or email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
            data-testid="input-search"
          />
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="pending" data-testid="tab-pending" className="gap-2">
            <ShieldAlert className="h-4 w-4" />
            Pending ({pendingVerifications.length})
          </TabsTrigger>
          <TabsTrigger value="draft" data-testid="tab-draft" className="gap-2">
            <Clock className="h-4 w-4" />
            Draft ({draftVerifications.length})
          </TabsTrigger>
          <TabsTrigger value="rejected" data-testid="tab-rejected" className="gap-2">
            <ShieldX className="h-4 w-4" />
            Rejected ({rejectedVerifications.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="mt-4 space-y-6">
          {filteredVerifications.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <ShieldCheck className="h-12 w-12 mx-auto text-green-500 mb-4" />
                <h3 className="text-lg font-semibold">All Caught Up!</h3>
                <p className="text-muted-foreground">No pending verification requests at this time.</p>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Solo Owner-Operator Section */}
              {filteredPendingSolo.length > 0 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 pb-2 border-b">
                    <User className="h-5 w-5 text-blue-600" />
                    <h3 className="text-lg font-semibold">Solo Owner-Operator</h3>
                    <Badge variant="secondary" className="ml-auto">{filteredPendingSolo.length}</Badge>
                  </div>
                  <div className="space-y-4">
                    {filteredPendingSolo.map(verification => renderVerificationCard(verification))}
                  </div>
                </div>
              )}

              {/* Fleet/Enterprise Section */}
              {filteredPendingFleet.length > 0 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 pb-2 border-b">
                    <Building2 className="h-5 w-5 text-purple-600" />
                    <h3 className="text-lg font-semibold">Fleet Carriers</h3>
                    <Badge variant="secondary" className="ml-auto">{filteredPendingFleet.length}</Badge>
                  </div>
                  <div className="space-y-4">
                    {filteredPendingFleet.map(verification => renderVerificationCard(verification))}
                  </div>
                </div>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="draft" className="mt-4 space-y-4">
          {filteredVerifications.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Clock className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold">No Draft Applications</h3>
                <p className="text-muted-foreground">No carriers have started their onboarding yet.</p>
              </CardContent>
            </Card>
          ) : (
            filteredVerifications.map(verification => renderVerificationCard(verification))
          )}
        </TabsContent>

        <TabsContent value="rejected" className="mt-4 space-y-4">
          {filteredVerifications.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <XCircle className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold">No Rejected Applications</h3>
                <p className="text-muted-foreground">No carriers have been rejected.</p>
              </CardContent>
            </Card>
          ) : (
            filteredVerifications.map(verification => renderVerificationCard(verification))
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Truck className="h-5 w-5" />
              {selectedVerification?.carrier?.companyName || "Carrier Details"}
            </DialogTitle>
            <DialogDescription>
              Review carrier details and uploaded documents
            </DialogDescription>
          </DialogHeader>
          
          {selectedVerification && (
            <div className="flex-1 overflow-y-auto pr-2 min-h-0">
              <div className="space-y-6 pb-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Carrier Information</CardTitle>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <Label className="text-muted-foreground">{selectedVerification.carrierType === "solo" ? "Driver Name" : "Company Name"}</Label>
                      <p className="font-medium">{selectedVerification.carrier?.companyName || "N/A"}</p>
                    </div>
                    <div>
                      <Label className="text-muted-foreground">Type</Label>
                      <p className="font-medium">
                        {selectedVerification.carrierType === "solo" ? "Solo Owner-Operator" : `Fleet (${selectedVerification.fleetSize} trucks)`}
                      </p>
                    </div>
                    <div>
                      <Label className="text-muted-foreground">Email</Label>
                      <p className="font-medium">{selectedVerification.carrier?.email || "N/A"}</p>
                    </div>
                    <div>
                      <Label className="text-muted-foreground">Phone</Label>
                      <p className="font-medium">{selectedVerification.carrier?.phone || "Not provided"}</p>
                    </div>
                    <div className="col-span-2">
                      <Label className="text-muted-foreground">Service Zones</Label>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {selectedVerification.carrier?.serviceZones?.map((zone, i) => (
                          <Badge key={i} variant="outline">{zone}</Badge>
                        )) || <span className="text-muted-foreground">Not specified</span>}
                      </div>
                    </div>
                    {selectedVerification.notes && selectedVerification.status !== "on_hold" && (
                      <div className="col-span-2">
                        <Label className="text-muted-foreground">Notes from Carrier</Label>
                        <p className="font-medium">{selectedVerification.notes}</p>
                      </div>
                    )}
                    {selectedVerification.status === "on_hold" && selectedVerification.notes && (
                      <div className="col-span-2">
                        <Label className="text-muted-foreground flex items-center gap-2">
                          <PauseCircle className="h-4 w-4 text-orange-500" />
                          Admin Notes (On Hold)
                        </Label>
                        <p className="font-medium text-orange-600 dark:text-orange-400">{selectedVerification.notes}</p>
                      </div>
                    )}
                    {selectedVerification.status === "rejected" && selectedVerification.rejectionReason && (
                      <div className="col-span-2">
                        <Label className="text-muted-foreground flex items-center gap-2">
                          <XCircle className="h-4 w-4 text-destructive" />
                          Rejection Reason
                        </Label>
                        <p className="font-medium text-destructive">{selectedVerification.rejectionReason}</p>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Solo Operator Details */}
                {selectedVerification.carrierType === "solo" && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <User className="h-4 w-4 text-blue-600" />
                        Solo Operator Details
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <Label className="text-muted-foreground">Aadhaar Number</Label>
                        <p className="font-medium">{selectedVerification.aadhaarNumber || "Not provided"}</p>
                      </div>
                      <div>
                        <Label className="text-muted-foreground">Driver License Number</Label>
                        <p className="font-medium">{selectedVerification.driverLicenseNumber || "Not provided"}</p>
                      </div>
                      <div>
                        <Label className="text-muted-foreground">PAN Number</Label>
                        <p className="font-medium">{selectedVerification.panNumber || "Not provided"}</p>
                      </div>
                      <div>
                        <Label className="text-muted-foreground">Permit Type</Label>
                        <p className="font-medium">
                          {selectedVerification.permitType === "national" ? "National Permit" : 
                           selectedVerification.permitType === "domestic" ? "State Permit" : "Not provided"}
                        </p>
                      </div>
                      <div>
                        <Label className="text-muted-foreground">License Plate Number</Label>
                        <p className="font-medium">{selectedVerification.licensePlateNumber || "Not provided"}</p>
                      </div>
                      <div>
                        <Label className="text-muted-foreground">Chassis Number</Label>
                        <p className="font-medium">{selectedVerification.chassisNumber || "Not provided"}</p>
                      </div>
                      <div>
                        <Label className="text-muted-foreground">Unique Registration Number</Label>
                        <p className="font-medium">{selectedVerification.uniqueRegistrationNumber || "Not provided"}</p>
                      </div>
                      <div>
                        <Label className="text-muted-foreground">Locality / Area</Label>
                        <p className="font-medium">{selectedVerification.businessLocality || "Not provided"}</p>
                      </div>
                      <div className="col-span-2">
                        <Label className="text-muted-foreground">Business Address</Label>
                        <p className="font-medium">{selectedVerification.businessAddress || "Not provided"}</p>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Fleet/Company Details */}
                {selectedVerification.carrierType === "enterprise" && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-purple-600" />
                        Fleet/Company Details
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <Label className="text-muted-foreground">Business Type</Label>
                        <p className="font-medium">
                          {selectedVerification.businessType === "sole_proprietor" ? "Sole Proprietor" :
                           selectedVerification.businessType === "registered_partnership" ? "Registered Partnership" :
                           selectedVerification.businessType === "non_registered_partnership" ? "Non-Registered Partnership" :
                           selectedVerification.businessType === "other" ? "Other (Pvt Ltd, LLP, etc.)" : "Not provided"}
                        </p>
                      </div>
                      <div>
                        <Label className="text-muted-foreground">Aadhaar Number</Label>
                        <p className="font-medium">{selectedVerification.aadhaarNumber || "Not provided"}</p>
                      </div>
                      {selectedVerification.businessType === "registered_partnership" && (
                        <div>
                          <Label className="text-muted-foreground">GSTIN Number</Label>
                          <p className="font-medium">
                            {selectedVerification.noGstinNumber 
                              ? "Does not have GSTIN" 
                              : (selectedVerification.gstinNumber || "Not provided")}
                          </p>
                        </div>
                      )}
                      {selectedVerification.businessType === "non_registered_partnership" && (
                        <>
                          <div>
                            <Label className="text-muted-foreground">Partner Name</Label>
                            <p className="font-medium">{selectedVerification.partnerName || "Not provided"}</p>
                          </div>
                          <div>
                            <Label className="text-muted-foreground">Partner Driver License</Label>
                            <p className="font-medium">{selectedVerification.driverLicenseNumber || "Not provided"}</p>
                          </div>
                          <div>
                            <Label className="text-muted-foreground">Partner PAN Number</Label>
                            <p className="font-medium">{selectedVerification.panNumber || "Not provided"}</p>
                          </div>
                        </>
                      )}
                      {selectedVerification.businessType === "other" && (
                        <div>
                          <Label className="text-muted-foreground">CIN Number</Label>
                          <p className="font-medium">{selectedVerification.cinNumber || "Not provided"}</p>
                        </div>
                      )}
                      <div>
                        <Label className="text-muted-foreground">Locality / Area</Label>
                        <p className="font-medium">{selectedVerification.businessLocality || "Not provided"}</p>
                      </div>
                      <div className="col-span-2">
                        <Label className="text-muted-foreground">Business Address</Label>
                        <p className="font-medium">{selectedVerification.businessAddress || "Not provided"}</p>
                      </div>
                      <div>
                        <Label className="text-muted-foreground">Fleet Size</Label>
                        <p className="font-medium">{selectedVerification.fleetSize || 1} truck(s)</p>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Bank Details */}
                {(selectedVerification.bankName || selectedVerification.bankAccountNumber || selectedVerification.bankIfscCode || selectedVerification.bankAccountHolderName) && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <CreditCard className="h-4 w-4 text-green-600" />
                        Bank Details
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <Label className="text-muted-foreground">Account Holder Name</Label>
                        <p className="font-medium">{selectedVerification.bankAccountHolderName || "Not provided"}</p>
                      </div>
                      <div>
                        <Label className="text-muted-foreground">Bank Name</Label>
                        <p className="font-medium">{selectedVerification.bankName || "Not provided"}</p>
                      </div>
                      <div>
                        <Label className="text-muted-foreground">Account Number</Label>
                        <p className="font-medium">{selectedVerification.bankAccountNumber || "Not provided"}</p>
                      </div>
                      <div>
                        <Label className="text-muted-foreground">IFSC Code</Label>
                        <p className="font-medium">{selectedVerification.bankIfscCode || "Not provided"}</p>
                      </div>
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Uploaded Documents</CardTitle>
                    <CardDescription>Review and verify each document (scroll to see all)</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3 max-h-[500px] overflow-y-auto pr-2">
                      {(selectedVerification.documents || []).length === 0 ? (
                        <p className="text-muted-foreground text-center py-4">No documents uploaded yet</p>
                      ) : (
                        sortDocumentsByPriority(selectedVerification.documents || []).map((doc) => (
                          <div key={doc.id} className="p-3 border rounded-lg space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <FileText className="h-5 w-5 text-muted-foreground" />
                                <div>
                                  <p className="font-medium">
                                    {doc.documentType === "address_proof" && selectedVerification?.addressProofType ? 
                                      getDocumentDisplayName(`address_proof_${selectedVerification.addressProofType === "office_photo_with_board" ? "office_photo" : selectedVerification.addressProofType}`) :
                                      getDocumentDisplayName(doc.documentType)}
                                  </p>
                                  <p className="text-sm text-muted-foreground">{doc.fileName}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {doc.uploadedAt ? `Uploaded ${format(new Date(doc.uploadedAt), "MMM d, yyyy")}` : "Recently uploaded"}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                {doc.status === "approved" ? (
                                  <Badge variant="default" className="bg-green-600"><CheckCircle className="h-3 w-3 mr-1" />Verified</Badge>
                                ) : doc.status === "rejected" ? (
                                  <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Rejected</Badge>
                                ) : (
                                  <Badge variant="secondary"><Clock className="h-3 w-3 mr-1" />Pending</Badge>
                                )}
                                <Button 
                                  variant="outline" 
                                  size="sm" 
                                  data-testid={`button-view-${doc.documentType}`}
                                  onClick={() => {
                                    setPreviewDoc(doc);
                                    setPreviewOpen(true);
                                  }}
                                >
                                  <Eye className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                            {doc.status === "pending" && (
                              <div className="flex items-center gap-2 pl-8">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-green-600 border-green-600 hover:bg-green-50 dark:hover:bg-green-950"
                                  onClick={() => handleDocApprove(doc)}
                                  disabled={documentVerifyMutation.isPending}
                                  data-testid={`button-approve-doc-${doc.documentType}`}
                                >
                                  <CheckCircle className="h-3 w-3 mr-1" />
                                  Approve
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-red-600 border-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                                  onClick={() => {
                                    setSelectedDocForReject(doc);
                                    setDocRejectDialogOpen(true);
                                  }}
                                  disabled={documentVerifyMutation.isPending}
                                  data-testid={`button-reject-doc-${doc.documentType}`}
                                >
                                  <XCircle className="h-3 w-3 mr-1" />
                                  Reject
                                </Button>
                              </div>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
          
          <DialogFooter className="flex-shrink-0 border-t pt-4">
            <Button variant="outline" onClick={() => setDetailsOpen(false)}>
              Close
            </Button>
            {selectedVerification?.status === "pending" && (
              <>
                <Button 
                  variant="destructive"
                  onClick={() => {
                    setRejectDialogOpen(true);
                  }}
                  data-testid="button-reject-carrier"
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  Reject
                </Button>
                <Button 
                  variant="secondary"
                  onClick={() => {
                    setHoldDialogOpen(true);
                  }}
                  data-testid="button-hold-carrier"
                >
                  <PauseCircle className="h-4 w-4 mr-2" />
                  Put on Hold
                </Button>
                <Button 
                  onClick={() => handleApprove(selectedVerification)}
                  disabled={approveMutation.isPending}
                  data-testid="button-approve-carrier"
                >
                  <CheckCircle className="h-4 w-4 mr-2" />
                  Approve & Verify
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Verification</DialogTitle>
            <DialogDescription>
              Please provide a reason for rejecting {selectedVerification?.carrier?.companyName}'s verification.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Rejection Reason</Label>
              <Textarea
                placeholder=""
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                className="mt-2"
                data-testid="input-reject-reason"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={handleReject}
              disabled={!rejectReason.trim() || rejectMutation.isPending}
              data-testid="button-confirm-reject"
            >
              Reject Verification
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Put on Hold Dialog */}
      <Dialog open={holdDialogOpen} onOpenChange={(open) => {
        setHoldDialogOpen(open);
        if (!open) setHoldNotes("");
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Put Verification on Hold</DialogTitle>
            <DialogDescription>
              Add notes explaining why {selectedVerification?.carrier?.companyName}'s verification is being put on hold.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Notes</Label>
              <Textarea
                placeholder=""
                value={holdNotes}
                onChange={(e) => setHoldNotes(e.target.value)}
                className="mt-2"
                data-testid="input-hold-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHoldDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              variant="secondary" 
              onClick={handleHold}
              disabled={!holdNotes.trim() || holdMutation.isPending}
              data-testid="button-confirm-hold"
            >
              <PauseCircle className="h-4 w-4 mr-2" />
              Put on Hold
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Document Preview Modal */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              {previewDoc && getDocumentDisplayName(previewDoc.documentType)}
            </DialogTitle>
            <DialogDescription>
              {previewDoc?.fileName}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {previewDoc && (
              <>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <Label className="text-muted-foreground">Document Type</Label>
                    <p className="font-medium">{getDocumentDisplayName(previewDoc.documentType)}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">File Name</Label>
                    <p className="font-medium">{previewDoc.fileName}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Upload Date</Label>
                    <p className="font-medium">
                      {previewDoc.uploadedAt ? format(new Date(previewDoc.uploadedAt), "MMM d, yyyy HH:mm") : "Recently uploaded"}
                    </p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Status</Label>
                    <div className="mt-1">
                      {previewDoc.status === "approved" ? (
                        <Badge className="bg-green-600"><CheckCircle className="h-3 w-3 mr-1" />Verified</Badge>
                      ) : previewDoc.status === "rejected" ? (
                        <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Rejected</Badge>
                      ) : (
                        <Badge variant="secondary"><Clock className="h-3 w-3 mr-1" />Pending Review</Badge>
                      )}
                    </div>
                  </div>
                </div>
                
                {/* Document Preview */}
                <div className="border rounded-lg bg-muted/30 p-6">
                  <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                    <div className="h-20 w-20 rounded-full bg-muted flex items-center justify-center mb-4">
                      <FileText className="h-10 w-10" />
                    </div>
                    <p className="text-lg font-medium text-foreground mb-2">
                      {previewDoc.fileName.endsWith('.pdf') ? 'PDF Document' : 'Image Document'}
                    </p>
                    <p className="text-sm mb-4">Click below to view the full document</p>
                    <div className="flex gap-2">
                      <Badge variant="outline" className="text-xs">
                        {previewDoc.fileName.split('.').pop()?.toUpperCase() || 'FILE'}
                      </Badge>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>
              Close
            </Button>
            <Button asChild data-testid="button-open-document">
              <a href={previewDoc?.fileUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4 mr-2" />
                Open in New Tab
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Document Rejection Dialog */}
      <Dialog open={docRejectDialogOpen} onOpenChange={(open) => {
        setDocRejectDialogOpen(open);
        if (!open) {
          setDocRejectReason("");
          setSelectedDocForReject(null);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Document</DialogTitle>
            <DialogDescription>
              Please provide a reason for rejecting this {selectedDocForReject ? getDocumentDisplayName(selectedDocForReject.documentType) : 'document'}. The carrier will be notified.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Rejection Reason</Label>
              <Textarea
                placeholder="Enter reason for rejection..."
                value={docRejectReason}
                onChange={(e) => setDocRejectReason(e.target.value)}
                className="mt-2"
                data-testid="input-doc-reject-reason"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDocRejectDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={handleDocReject}
              disabled={!docRejectReason.trim() || documentVerifyMutation.isPending}
              data-testid="button-confirm-doc-reject"
            >
              Reject Document
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
