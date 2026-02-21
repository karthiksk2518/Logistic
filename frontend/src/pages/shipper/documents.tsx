import { useState, useMemo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useUpload } from "@/hooks/use-upload";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useLoads } from "@/lib/api-hooks";
import { useAuth } from "@/lib/auth-context";
import { onMarketplaceEvent } from "@/lib/marketplace-socket";
import { 
  FileText, Upload, Search, Filter, Download, Eye, Trash2, AlertCircle, 
  CheckCircle, X, Tag, Calendar, Link2, Plus, RotateCw, ZoomIn, ZoomOut,
  ChevronLeft, ChevronRight, Clock, FileImage, Info, Edit2, History,
  Folder, FolderOpen, ArrowLeft, Receipt, Truck, Shield, Image, FileCheck,
  Loader2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/empty-state";
import { useToast } from "@/hooks/use-toast";
import {
  useDocumentVault,
  documentCategoryLabels,
  formatFileSize,
  formatDate,
  getDaysUntilExpiry,
  type VaultDocument,
  type DocumentCategory,
  type DocumentStatus,
} from "@/lib/document-vault-store";

type SortOption = "newest" | "oldest" | "expiring" | "largest";

// Helper function to check if a file URL is displayable
const isDisplayableUrl = (url: string | undefined): boolean => {
  if (!url) return false;
  return url.startsWith('http') || url.startsWith('data:') || url.startsWith('/objects/');
};

// Shipper-specific document categories (excluding carrier documents)
const shipperDocumentCategories: DocumentCategory[] = [
  "pod", "invoice", "lr", "eway_bill", "photos", "verification", "other"
];

// Folder configuration for shipper document categories
const documentFolders: Partial<Record<DocumentCategory, {
  label: string;
  icon: typeof FileText;
  color: string;
  bgColor: string;
  description: string;
}>> = {
  eway_bill: {
    label: "E-way Bills",
    icon: Shield,
    color: "text-purple-600 dark:text-purple-400",
    bgColor: "bg-purple-100 dark:bg-purple-900/30",
    description: "GST e-way bill documents for transport",
  },
  lr: {
    label: "LR / Consignments",
    icon: FileCheck,
    color: "text-orange-600 dark:text-orange-400",
    bgColor: "bg-orange-100 dark:bg-orange-900/30",
    description: "Lorry receipts and consignment notes",
  },
  pod: {
    label: "Proof of Delivery",
    icon: CheckCircle,
    color: "text-green-600 dark:text-green-400",
    bgColor: "bg-green-100 dark:bg-green-900/30",
    description: "Delivery confirmations and receipts",
  },
  bol: {
    label: "Bill of Lading",
    icon: Truck,
    color: "text-blue-600 dark:text-blue-400",
    bgColor: "bg-blue-100 dark:bg-blue-900/30",
    description: "Transport and shipping contracts",
  },
  invoice: {
    label: "Invoices",
    icon: Receipt,
    color: "text-emerald-600 dark:text-emerald-400",
    bgColor: "bg-emerald-100 dark:bg-emerald-900/30",
    description: "Billing and payment documents",
  },
  photos: {
    label: "Photos",
    icon: Image,
    color: "text-pink-600 dark:text-pink-400",
    bgColor: "bg-pink-100 dark:bg-pink-900/30",
    description: "Loading, unloading, and delivery photos",
  },
  weight_slip: {
    label: "Weight Slips",
    icon: FileText,
    color: "text-cyan-600 dark:text-cyan-400",
    bgColor: "bg-cyan-100 dark:bg-cyan-900/30",
    description: "Weighbridge and weight verification slips",
  },
  verification: {
    label: "Shipper's Documents",
    icon: Shield,
    color: "text-indigo-600 dark:text-indigo-400",
    bgColor: "bg-indigo-100 dark:bg-indigo-900/30",
    description: "Business verification and onboarding documents",
  },
  other: {
    label: "Other Documents",
    icon: Folder,
    color: "text-gray-600 dark:text-gray-400",
    bgColor: "bg-gray-100 dark:bg-gray-900/30",
    description: "Miscellaneous supporting documents",
  },
};

const shipperCategoryLabels: Record<string, string> = {
  pod: "Proof of Delivery",
  bol: "Bill of Lading",
  invoice: "Invoice",
  lr: "LR / Consignment Note",
  eway_bill: "E-way Bill",
  weight_slip: "Weight Slip",
  photos: "Photos",
  verification: "Verification Document",
  other: "Other",
};

// Map API document types to our category types
const apiDocTypeToCategory: Record<string, DocumentCategory> = {
  lr_consignment: "lr",
  eway_bill: "eway_bill",
  loading_photos: "photos",
  delivery_photos: "photos",
  pod: "pod",
  invoice: "invoice",
  weight_slip: "weight_slip",
  bol: "bol",
  other: "other",
  gst_certificate: "verification",
  pan_card: "verification",
  incorporation_certificate: "verification",
  cancelled_cheque: "verification",
  address_proof: "verification",
  selfie: "verification",
  msme_certificate: "verification",
  udyam_certificate: "verification",
  lr_copy: "verification",
  alternative_authorization: "verification",
};

interface ApiDocument {
  id: string;
  userId: string;
  loadId?: string;
  shipmentId?: string;
  documentType: string;
  fileName: string;
  fileUrl: string;
  fileSize?: number;
  isVerified: boolean;
  createdAt: string;
  load?: {
    shipperLoadNumber?: number;
    adminReferenceNumber?: number;
  } | null;
  isOnboardingDoc?: boolean;
}

export default function DocumentsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [location] = useLocation();
  const {
    templates,
    uploadDocument,
    deleteDocument,
    verifyDocument,
    replaceDocument,
    getExpiringDocuments,
    getExpiredDocuments,
  } = useDocumentVault();
  const { user } = useAuth();
  const { data: onboardingData } = useQuery<any>({
    queryKey: ['/api/shipper/onboarding'],
    enabled: !!user,
  });
  const isTransporter = onboardingData?.shipperRole === "transporter";
  const { data: allLoads } = useLoads();
  const activeLoads = useMemo(() => {
    return (allLoads || [])
      .filter((load: any) => load.shipperId === user?.id)
      .map((load: any) => {
        const loadNum = load.adminReferenceNumber || load.shipperLoadNumber;
        const loadId = loadNum ? `LD-${String(loadNum).padStart(3, '0')}` : load.id.slice(0, 8);
        return {
          loadId,
          pickup: load.pickupCity || load.pickupLocation || '',
          drop: load.dropoffCity || load.dropoffLocation || '',
        };
      });
  }, [allLoads, user?.id]);
  
  // Get initial load filter from URL query parameter
  const getInitialLoadFilter = () => {
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      const loadParam = urlParams.get('load');
      if (loadParam) {
        // If already in LD-XXX format, use directly
        if (loadParam.startsWith('LD-')) {
          return loadParam;
        }
        // Otherwise, format load ID to match our format (LD-XXX)
        const loadNum = parseInt(loadParam);
        if (!isNaN(loadNum)) {
          return `LD-${String(loadNum).padStart(3, '0')}`;
        }
        return loadParam;
      }
    }
    return "all";
  };
  
  // Fetch real shipment documents from API
  const { data: apiDocuments = [], isLoading: isLoadingApiDocs } = useQuery<ApiDocument[]>({
    queryKey: ['/api/shipper/documents'],
    refetchInterval: 30000, // Refresh every 30 seconds
  });
  
  // Convert API documents to VaultDocument format (real data only)
  const documents = useMemo(() => {
    const convertedApiDocs: VaultDocument[] = apiDocuments.map((doc) => {
      const category = apiDocTypeToCategory[doc.documentType] || "other";
      const loadNumber = doc.load?.adminReferenceNumber || doc.load?.shipperLoadNumber;
      const loadIdStr = loadNumber ? `LD-${String(loadNumber).padStart(3, '0')}` : doc.loadId;
      
      return {
        documentId: `api-${doc.id}`,
        fileName: doc.fileName,
        fileSize: doc.fileSize || 0,
        fileType: doc.fileName.toLowerCase().endsWith('.pdf') ? "pdf" as const : "image" as const,
        fileUrl: doc.fileUrl,
        category,
        loadId: doc.isOnboardingDoc ? "Verification" : loadIdStr,
        shipmentId: doc.shipmentId,
        uploadedBy: doc.isOnboardingDoc ? "Shipper (Onboarding)" : "Carrier",
        uploadedDate: new Date(doc.createdAt),
        status: "active" as DocumentStatus,
        tags: doc.isOnboardingDoc ? [doc.documentType, "verification"] : [doc.documentType],
        version: 1,
        isVerified: doc.isVerified,
      };
    });
    
    return convertedApiDocs;
  }, [apiDocuments]);

  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<DocumentCategory | "all">("all");
  const [statusFilter, setStatusFilter] = useState<DocumentStatus | "all">("all");
  const [loadFilter, setLoadFilter] = useState(() => getInitialLoadFilter());
  const [sortBy, setSortBy] = useState<SortOption>("newest");
  const [selectedFolder, setSelectedFolder] = useState<DocumentCategory | null>(null);
  
  // Update load filter when URL changes
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const loadParam = urlParams.get('load');
    if (loadParam) {
      // Use the load param directly if it's already in LD-XXX format, otherwise format it
      if (loadParam.startsWith('LD-')) {
        setLoadFilter(loadParam);
      } else {
        const loadNum = parseInt(loadParam);
        if (!isNaN(loadNum)) {
          setLoadFilter(`LD-${String(loadNum).padStart(3, '0')}`);
        } else {
          setLoadFilter(loadParam);
        }
      }
    }
  }, [location]);

  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<VaultDocument | null>(null);
  const [expiringViewOpen, setExpiringViewOpen] = useState(false);

  // File upload with real object storage
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadedFileUrl, setUploadedFileUrl] = useState<string>("");
  const [uploadedFileSize, setUploadedFileSize] = useState<number>(0);
  
  const { uploadFile, isUploading, error: uploadError } = useUpload({
    onSuccess: (response) => {
      // Use the object path directly - the server has /objects/:objectPath route
      // The objectPath is like "/objects/uploads/uuid"
      setUploadedFileUrl(response.objectPath);
      setUploadedFileSize(response.metadata.size);
      toast({
        title: t('documents.uploadComplete'),
        description: t('documents.fileUploaded'),
      });
    },
    onError: (err) => {
      console.error("Upload error:", err);
      toast({
        title: t('common.error'),
        description: err.message || t('documents.uploadFailed'),
        variant: "destructive",
      });
    },
  });

  const [uploadForm, setUploadForm] = useState({
    fileName: "",
    fileType: "pdf" as "pdf" | "image",
    category: "" as DocumentCategory | "",
    loadId: "none",
    notes: "",
    tags: "",
    expiryDate: "",
  });
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);

  // Listen for real-time document upload events
  // Note: The WebSocket connection is established at the app level, so we only subscribe to events here
  useEffect(() => {
    const unsubscribe = onMarketplaceEvent("shipment_document_uploaded", (data: any) => {
      const docType = data?.document?.documentType || data?.documentType;
      const categoryMapping: Record<string, string> = {
        lr_consignment: "LR / Consignment",
        eway_bill: "E-way Bill",
        loading_photos: "Photos",
        delivery_photos: "Photos",
        pod: "Proof of Delivery",
        invoice: "Invoice",
        weight_slip: "Weight Slip",
        bol: "Bill of Lading",
        gst_certificate: "Verification Document",
        pan_card: "Verification Document",
        incorporation_certificate: "Verification Document",
        cancelled_cheque: "Verification Document",
        address_proof: "Verification Document",
        selfie: "Verification Document",
        msme_certificate: "Verification Document",
        udyam_certificate: "Verification Document",
        lr_copy: "Verification Document",
        alternative_authorization: "Verification Document",
        other: "Other",
      };
      const categoryName = categoryMapping[docType] || docType || "Document";
      
      // Show toast notification for new document
      toast({
        title: t('documents.newDocumentReceived', { defaultValue: "New Document Received" }),
        description: t('documents.documentAddedToCategory', { 
          defaultValue: `${categoryName} document has been added to your vault`,
          category: categoryName 
        }),
      });
      
      // Query is already invalidated by the WebSocket handler in marketplace-socket.ts
    });
    
    return () => {
      unsubscribe();
    };
  }, [toast, t]);

  // Filter expiring/expired docs to only show shipper-relevant categories (not carrier documents)
  const expiringDocs = getExpiringDocuments().filter(doc => shipperDocumentCategories.includes(doc.category));
  const expiredDocs = getExpiredDocuments().filter(doc => shipperDocumentCategories.includes(doc.category));

  // Count documents per category for folder badges
  const documentCountsByCategory = useMemo(() => {
    const counts: Record<DocumentCategory, number> = {} as Record<DocumentCategory, number>;
    shipperDocumentCategories.forEach(cat => {
      counts[cat] = documents.filter(d => d.category === cat && shipperDocumentCategories.includes(d.category)).length;
    });
    return counts;
  }, [documents]);

  const filteredAndSortedDocs = useMemo(() => {
    let result = documents.filter(doc => {
      // Only show shipper-relevant document categories
      const isShipperCategory = shipperDocumentCategories.includes(doc.category);
      const matchesSearch = 
        doc.fileName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        doc.loadId?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        doc.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase()));
      // When a folder is selected, filter by that folder
      const matchesFolder = selectedFolder === null || doc.category === selectedFolder;
      const matchesType = typeFilter === "all" || doc.category === typeFilter;
      const matchesStatus = statusFilter === "all" || doc.status === statusFilter;
      const matchesLoad = loadFilter === "all" || doc.loadId === loadFilter;
      return isShipperCategory && matchesSearch && matchesFolder && matchesType && matchesStatus && matchesLoad;
    });

    result.sort((a, b) => {
      switch (sortBy) {
        case "newest":
          return b.uploadedDate.getTime() - a.uploadedDate.getTime();
        case "oldest":
          return a.uploadedDate.getTime() - b.uploadedDate.getTime();
        case "expiring":
          const aExp = a.expiryDate?.getTime() || Infinity;
          const bExp = b.expiryDate?.getTime() || Infinity;
          return aExp - bExp;
        case "largest":
          return b.fileSize - a.fileSize;
        default:
          return 0;
      }
    });

    return result;
  }, [documents, searchQuery, selectedFolder, typeFilter, statusFilter, loadFilter, sortBy]);

  // Handle folder navigation
  const handleFolderClick = (category: DocumentCategory) => {
    setSelectedFolder(category);
    setSearchQuery("");
    setStatusFilter("all");
    setLoadFilter("all");
  };

  const handleBackToFolders = () => {
    setSelectedFolder(null);
    setSearchQuery("");
  };

  // Handle file selection
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      // Auto-fill filename from the file
      setUploadForm(prev => ({
        ...prev,
        fileName: file.name,
        fileType: file.type.includes('pdf') ? 'pdf' : 'image',
      }));
      // Upload the file immediately to object storage
      await uploadFile(file);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleUpload = () => {
    if (!uploadForm.category) {
      toast({
        title: t('common.error'),
        description: t('documents.selectDocumentType'),
        variant: "destructive",
      });
      return;
    }

    if (!uploadedFileUrl) {
      toast({
        title: t('common.error'),
        description: t('documents.pleaseSelectFile'),
        variant: "destructive",
      });
      return;
    }

    const template = templates.find(t => t.id === uploadForm.category);
    let expiryDate: Date | undefined;
    if (uploadForm.expiryDate) {
      expiryDate = new Date(uploadForm.expiryDate);
    } else if (template?.hasExpiry && template.defaultExpiryMonths) {
      expiryDate = new Date();
      expiryDate.setMonth(expiryDate.getMonth() + template.defaultExpiryMonths);
    }

    // Use the real uploaded file URL
    uploadDocument({
      fileName: uploadForm.fileName || selectedFile?.name || 'document',
      fileSize: uploadedFileSize || selectedFile?.size || 0,
      fileType: uploadForm.fileType,
      fileUrl: uploadedFileUrl,
      category: uploadForm.category as DocumentCategory,
      loadId: uploadForm.loadId && uploadForm.loadId !== "none" ? uploadForm.loadId : undefined,
      uploadedBy: "You",
      expiryDate,
      notes: uploadForm.notes || undefined,
      tags: uploadForm.tags ? uploadForm.tags.split(",").map(t => t.trim()) : template?.suggestedTags || [],
      isVerified: false,
    });

    toast({
      title: t('documents.documentUploaded'),
      description: `${uploadForm.fileName} ${t('documents.addedToVault')}`,
    });

    // Reset form
    setUploadForm({
      fileName: "",
      fileType: "pdf",
      category: "",
      loadId: "none",
      notes: "",
      tags: "",
      expiryDate: "",
    });
    setSelectedFile(null);
    setUploadedFileUrl("");
    setUploadedFileSize(0);
    setUploadDialogOpen(false);
  };

  const handleView = (doc: VaultDocument) => {
    setSelectedDocument(doc);
    setZoom(100);
    setRotation(0);
    setViewerOpen(true);
  };

  const handleDetails = (doc: VaultDocument) => {
    setSelectedDocument(doc);
    setDetailPanelOpen(true);
  };

  const handleDelete = (doc: VaultDocument) => {
    deleteDocument(doc.documentId);
    toast({
      title: "Document Deleted",
      description: `${doc.fileName} has been removed from your vault.`,
    });
    setDetailPanelOpen(false);
  };

  const handleVerify = (doc: VaultDocument) => {
    verifyDocument(doc.documentId);
    toast({
      title: "Document Verified",
      description: `${doc.fileName} has been marked as verified.`,
    });
  };

  const handleDownload = (doc: VaultDocument) => {
    toast({
      title: "Download Started",
      description: `Downloading ${doc.fileName}...`,
    });
  };

  const handleSelectTemplate = (templateId: string) => {
    const template = templates.find(t => t.id === templateId);
    if (template) {
      setUploadForm(prev => ({
        ...prev,
        category: templateId as DocumentCategory,
        tags: template.suggestedTags.join(", "),
      }));
    }
  };

  const getStatusBadge = (status: DocumentStatus) => {
    switch (status) {
      case "active":
        return <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 no-default-hover-elevate no-default-active-elevate">Active</Badge>;
      case "expiring_soon":
        return <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 no-default-hover-elevate no-default-active-elevate">Expiring Soon</Badge>;
      case "expired":
        return <Badge variant="destructive" className="no-default-hover-elevate no-default-active-elevate">Expired</Badge>;
    }
  };

  const linkedLoads = Array.from(new Set(documents.filter(d => d.loadId).map(d => d.loadId!)));

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="text-2xl font-bold">{t('documents.title')}</h1>
          <p className="text-muted-foreground">{isTransporter ? "Transporter Documents" : t('shipper.documentsTitle')}</p>
        </div>
        <Button onClick={() => setUploadDialogOpen(true)} data-testid="button-upload-document">
          <Upload className="h-4 w-4 mr-2" />
          {t('documents.uploadDocument')}
        </Button>
      </div>

      {(expiringDocs.length > 0 || expiredDocs.length > 0) && !selectedFolder && (
        <Card className="mb-6 border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
              <div className="flex-1">
                <p className="font-medium text-amber-800 dark:text-amber-200">
                  {expiredDocs.length > 0 && `${expiredDocs.length} ${t('documents.expired')}`}
                  {expiredDocs.length > 0 && expiringDocs.length > 0 && " & "}
                  {expiringDocs.length > 0 && `${expiringDocs.length} ${t('documents.expiringSoon')}`}
                </p>
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  {t('documents.expiringDocuments')}
                </p>
              </div>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => setExpiringViewOpen(true)}
                data-testid="button-view-expiring"
              >
                {t('documents.viewDocument')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Folder View - Show when no folder is selected */}
      {selectedFolder === null ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
            {shipperDocumentCategories.map((category) => {
              const folder = documentFolders[category];
              if (!folder) return null;
              const count = documentCountsByCategory[category] || 0;
              const FolderIcon = folder.icon;
              
              return (
                <Card 
                  key={category}
                  className="hover-elevate cursor-pointer transition-all"
                  onClick={() => handleFolderClick(category)}
                  data-testid={`folder-${category}`}
                >
                  <CardContent className="p-5">
                    <div className="flex items-start gap-3 mb-3">
                      <div className={`flex h-12 w-12 items-center justify-center rounded-lg ${folder.bgColor}`}>
                        <FolderIcon className={`h-6 w-6 ${folder.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm">{category === "verification" && isTransporter ? "Transporter's Documents" : folder.label}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{count} {count === 1 ? 'document' : 'documents'}</p>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">{folder.description}</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Quick Stats */}
          <Card className="mb-6">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Quick Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="text-center p-3 rounded-lg bg-muted/50">
                  <p className="text-2xl font-bold">{documents.filter(d => shipperDocumentCategories.includes(d.category)).length}</p>
                  <p className="text-xs text-muted-foreground">Total Documents</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-green-50 dark:bg-green-900/20">
                  <p className="text-2xl font-bold text-green-600 dark:text-green-400">
                    {documents.filter(d => d.status === "active" && shipperDocumentCategories.includes(d.category)).length}
                  </p>
                  <p className="text-xs text-muted-foreground">Active</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20">
                  <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{expiringDocs.length}</p>
                  <p className="text-xs text-muted-foreground">Expiring Soon</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-red-50 dark:bg-red-900/20">
                  <p className="text-2xl font-bold text-red-600 dark:text-red-400">{expiredDocs.length}</p>
                  <p className="text-xs text-muted-foreground">Expired</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        /* Folder Contents View - Show when a folder is selected */
        <>
          {/* Breadcrumb and Back Button */}
          <div className="flex items-center gap-3 mb-6">
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={handleBackToFolders}
              data-testid="button-back-to-folders"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Folders
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <div className="flex items-center gap-2">
              {(() => {
                const folder = documentFolders[selectedFolder];
                if (!folder) return null;
                const FolderIcon = folder.icon;
                return (
                  <>
                    <div className={`flex h-8 w-8 items-center justify-center rounded ${folder.bgColor}`}>
                      <FolderIcon className={`h-4 w-4 ${folder.color}`} />
                    </div>
                    <span className="font-medium">{selectedFolder === "verification" && isTransporter ? "Transporter's Documents" : folder.label}</span>
                    <Badge variant="secondary" className="ml-2 no-default-hover-elevate no-default-active-elevate">
                      {filteredAndSortedDocs.length} documents
                    </Badge>
                  </>
                );
              })()}
            </div>
          </div>

          {/* Search and Filters for folder contents */}
          <div className="flex flex-col gap-4 mb-6">
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search documents in this folder..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                  data-testid="input-search-documents"
                />
              </div>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as DocumentStatus | "all")}>
                <SelectTrigger className="w-full sm:w-40" data-testid="select-status-filter">
                  <SelectValue placeholder={t('common.status')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('common.all')}</SelectItem>
                  <SelectItem value="active">{t('common.active')}</SelectItem>
                  <SelectItem value="expiring_soon">{t('documents.expiringSoon')}</SelectItem>
                  <SelectItem value="expired">{t('documents.expired')}</SelectItem>
                </SelectContent>
              </Select>
              <Select value={loadFilter} onValueChange={setLoadFilter}>
                <SelectTrigger className="w-full sm:w-40" data-testid="select-load-filter">
                  <Link2 className="h-4 w-4 mr-2" />
                  <SelectValue placeholder={t('loads.title')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('common.all')} {t('loads.title')}</SelectItem>
                  {linkedLoads.map(loadId => (
                    <SelectItem key={loadId} value={loadId}>{loadId}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
                <SelectTrigger className="w-full sm:w-36" data-testid="select-sort">
                  <SelectValue placeholder={t('common.sortBy')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest First</SelectItem>
                  <SelectItem value="oldest">Oldest First</SelectItem>
                  <SelectItem value="expiring">Expiring Soon</SelectItem>
                  <SelectItem value="largest">Largest First</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Document Cards */}
          {filteredAndSortedDocs.length === 0 ? (
            <EmptyState
              icon={Folder}
              title="No documents in this folder"
              description="Upload documents to organize them in this category."
              actionLabel={t('documents.uploadDocument')}
              onAction={() => setUploadDialogOpen(true)}
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredAndSortedDocs.map((doc) => (
                <Card 
                  key={doc.documentId} 
                  className="hover-elevate cursor-pointer" 
                  onClick={() => handleDetails(doc)}
                  data-testid={`document-card-${doc.documentId}`}
                >
                  <CardContent className="p-5">
                    <div className="flex items-start gap-3 mb-4">
                      <div className={`flex h-10 w-10 items-center justify-center rounded-lg flex-shrink-0 ${
                        doc.fileType === "pdf" 
                          ? "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"
                          : "bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
                      }`}>
                        {doc.fileType === "pdf" ? <FileText className="h-5 w-5" /> : <FileImage className="h-5 w-5" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate" data-testid={`text-filename-${doc.documentId}`}>
                          {doc.fileName}
                        </p>
                        <p className="text-xs text-muted-foreground">{formatFileSize(doc.fileSize)}</p>
                      </div>
                      {doc.isVerified ? (
                        <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-amber-500 flex-shrink-0" />
                      )}
                    </div>

                    <div className="space-y-2 mb-4">
                      <div className="flex items-center justify-between gap-2">
                        {getStatusBadge(doc.status)}
                      </div>
                      {doc.loadId && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">{t('loads.title')}</span>
                          <span className="font-medium">{doc.loadId}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{t('documents.uploadedOn')}</span>
                        <span>{formatDate(doc.uploadedDate)}</span>
                      </div>
                      {doc.expiryDate && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">{t('documents.expiryDate')}</span>
                          <span className={doc.status === "expired" ? "text-destructive" : doc.status === "expiring_soon" ? "text-amber-600 dark:text-amber-400" : ""}>
                            {formatDate(doc.expiryDate)}
                            {doc.status !== "active" && ` (${getDaysUntilExpiry(doc.expiryDate)}d)`}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="flex-1" 
                        onClick={() => handleView(doc)}
                        data-testid={`button-view-${doc.documentId}`}
                      >
                        <Eye className="h-4 w-4 mr-1" />
                        {t('common.view')}
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="flex-1"
                        onClick={() => handleDownload(doc)}
                        data-testid={`button-download-${doc.documentId}`}
                      >
                        <Download className="h-4 w-4 mr-1" />
                        {t('common.download')}
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="icon"
                        onClick={() => handleDelete(doc)}
                        data-testid={`button-delete-${doc.documentId}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('documents.uploadDocument')}</DialogTitle>
            <DialogDescription>
              {t('documents.dragAndDrop')}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t('documents.documentType')}</Label>
              <div className="grid grid-cols-3 gap-2">
                {templates.slice(0, 6).map(template => (
                  <Button
                    key={template.id}
                    variant={uploadForm.category === template.id ? "default" : "outline"}
                    size="sm"
                    onClick={() => handleSelectTemplate(template.id)}
                    className="text-xs"
                    data-testid={`button-template-${template.id}`}
                  >
                    {template.name.split(" ")[0]}
                  </Button>
                ))}
              </div>
            </div>

            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileSelect}
              accept=".pdf,.jpg,.jpeg,.png,.gif,.webp"
              className="hidden"
              data-testid="input-file-upload"
            />
            <div 
              className={`border-2 border-dashed rounded-lg p-6 text-center hover-elevate cursor-pointer transition-colors ${
                selectedFile ? 'border-green-500 bg-green-500/5' : 'border-border'
              }`}
              onClick={() => fileInputRef.current?.click()}
              data-testid="dropzone-upload"
            >
              {isUploading ? (
                <>
                  <Loader2 className="h-8 w-8 mx-auto mb-2 text-primary animate-spin" />
                  <p className="text-sm font-medium mb-1">{t('documents.uploadingFile')}</p>
                  <p className="text-xs text-muted-foreground">{t('common.pleaseWait')}...</p>
                </>
              ) : selectedFile && uploadedFileUrl ? (
                <>
                  <CheckCircle className="h-8 w-8 mx-auto mb-2 text-green-500" />
                  <p className="text-sm font-medium mb-1 text-green-600">{selectedFile.name}</p>
                  <p className="text-xs text-muted-foreground">{t('documents.fileReady')}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedFile(null);
                      setUploadedFileUrl("");
                      setUploadedFileSize(0);
                      setUploadForm(prev => ({ ...prev, fileName: "" }));
                    }}
                    data-testid="button-clear-file"
                  >
                    <X className="h-4 w-4 mr-1" />
                    {t('common.change')}
                  </Button>
                </>
              ) : (
                <>
                  <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-sm font-medium mb-1">{t('documents.clickToUpload')}</p>
                  <p className="text-xs text-muted-foreground">{t('documents.supportedFormats')}: PDF, JPG, PNG</p>
                </>
              )}
              {uploadError && (
                <p className="text-xs text-red-500 mt-2">{uploadError.message}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="fileName">{t('documents.documentName')}</Label>
                <Input
                  id="fileName"
                  placeholder={t('common.name') + '...'}
                  value={uploadForm.fileName}
                  onChange={(e) => setUploadForm(prev => ({ ...prev, fileName: e.target.value }))}
                  data-testid="input-file-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fileType">{t('common.type')}</Label>
                <Select 
                  value={uploadForm.fileType} 
                  onValueChange={(v) => setUploadForm(prev => ({ ...prev, fileType: v as "pdf" | "image" }))}
                >
                  <SelectTrigger data-testid="select-file-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pdf">PDF</SelectItem>
                    <SelectItem value="image">Image</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="category">{t('documents.documentType')}</Label>
                <Select 
                  value={uploadForm.category} 
                  onValueChange={(v) => setUploadForm(prev => ({ ...prev, category: v as DocumentCategory }))}
                >
                  <SelectTrigger data-testid="select-category">
                    <SelectValue placeholder={t('documents.selectDocumentType')} />
                  </SelectTrigger>
                  <SelectContent>
                    {shipperDocumentCategories.map((cat) => (
                      <SelectItem key={cat} value={cat}>{shipperCategoryLabels[cat]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="loadId">{t('loads.title')} ({t('common.optional')})</Label>
                <Select 
                  value={uploadForm.loadId} 
                  onValueChange={(v) => setUploadForm(prev => ({ ...prev, loadId: v }))}
                >
                  <SelectTrigger data-testid="select-load-link">
                    <SelectValue placeholder={t('common.select') + '...'} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('common.none')}</SelectItem>
                    {activeLoads.map(load => (
                      <SelectItem key={load.loadId} value={load.loadId}>
                        {load.loadId} - {load.pickup} to {load.drop}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="expiryDate">{t('documents.expiryDate')} ({t('common.optional')})</Label>
              <Input
                id="expiryDate"
                type="date"
                value={uploadForm.expiryDate}
                onChange={(e) => setUploadForm(prev => ({ ...prev, expiryDate: e.target.value }))}
                data-testid="input-expiry-date"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="tags">{t('documents.tags')}</Label>
              <div className="flex items-center gap-2">
                <Tag className="h-4 w-4 text-muted-foreground" />
                <Input
                  id="tags"
                  placeholder={t('documents.addTag') + '...'}
                  value={uploadForm.tags}
                  onChange={(e) => setUploadForm(prev => ({ ...prev, tags: e.target.value }))}
                  data-testid="input-tags"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">{t('common.notes')}</Label>
              <Textarea
                id="notes"
                placeholder={t('common.notes') + '...'}
                value={uploadForm.notes}
                onChange={(e) => setUploadForm(prev => ({ ...prev, notes: e.target.value }))}
                rows={2}
                data-testid="input-notes"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setUploadDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleUpload} data-testid="button-confirm-upload">
              <Upload className="h-4 w-4 mr-2" />
              {t('documents.uploadDocument')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={viewerOpen} onOpenChange={setViewerOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedDocument?.fileType === "pdf" ? <FileText className="h-5 w-5" /> : <FileImage className="h-5 w-5" />}
              {selectedDocument?.fileName}
            </DialogTitle>
          </DialogHeader>
          
          <div className="flex items-center justify-center gap-2 p-2 border-b">
            <Button variant="outline" size="icon" onClick={() => setZoom(z => Math.max(25, z - 25))}>
              <ZoomOut className="h-4 w-4" />
            </Button>
            <span className="text-sm min-w-12 text-center">{zoom}%</span>
            <Button variant="outline" size="icon" onClick={() => setZoom(z => Math.min(200, z + 25))}>
              <ZoomIn className="h-4 w-4" />
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <Button variant="outline" size="icon" onClick={() => setRotation(r => (r + 90) % 360)}>
              <RotateCw className="h-4 w-4" />
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <Button variant="outline" size="icon">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm">Page 1 of 1</span>
            <Button variant="outline" size="icon">
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <Button variant="outline" size="sm" onClick={() => selectedDocument && handleDownload(selectedDocument)}>
              <Download className="h-4 w-4 mr-2" />
              {t('common.download')}
            </Button>
          </div>
          
          <div className="flex items-center justify-center bg-muted rounded-lg min-h-[400px] overflow-auto">
            <div 
              className="flex items-center justify-center p-4 w-full h-full"
              style={{ 
                transform: `scale(${zoom / 100}) rotate(${rotation}deg)`,
                transition: "transform 0.2s ease"
              }}
            >
              {selectedDocument?.fileType === "pdf" ? (
                isDisplayableUrl(selectedDocument.fileUrl) ? (
                  <iframe 
                    src={selectedDocument.fileUrl} 
                    className="w-full h-[500px] border-0 rounded-lg bg-white"
                    title={selectedDocument.fileName}
                  />
                ) : (
                  <div className="bg-background border rounded-lg p-8 shadow-lg min-w-[300px]">
                    <div className="flex items-center gap-2 mb-4">
                      <FileText className="h-8 w-8 text-red-500" />
                      <div>
                        <p className="font-semibold">{selectedDocument.fileName}</p>
                        <p className="text-sm text-muted-foreground">{formatFileSize(selectedDocument.fileSize)}</p>
                      </div>
                    </div>
                    <div className="space-y-2 text-sm text-muted-foreground">
                      <p>Category: {shipperCategoryLabels[selectedDocument.category] || documentCategoryLabels[selectedDocument.category]}</p>
                      <p>Uploaded: {formatDate(selectedDocument.uploadedDate)}</p>
                      {selectedDocument.loadId && <p>Load: {selectedDocument.loadId}</p>}
                      {selectedDocument.notes && <p>Notes: {selectedDocument.notes}</p>}
                    </div>
                    <div className="mt-4 pt-4 border-t text-center">
                      <p className="text-xs text-muted-foreground mb-2">
                        Document stored locally
                      </p>
                      {selectedDocument.fileUrl && (
                        <Button size="sm" variant="outline" onClick={() => {
                          const fileUrl = selectedDocument.fileUrl || '';
                          const url = fileUrl.startsWith('http') || fileUrl.startsWith('data:') || fileUrl.startsWith('/objects/') 
                            ? fileUrl 
                            : `/objects/${fileUrl}`;
                          window.open(url, '_blank');
                        }}>
                          <Download className="h-4 w-4 mr-2" />
                          Open Document
                        </Button>
                      )}
                    </div>
                  </div>
                )
              ) : (
                isDisplayableUrl(selectedDocument?.fileUrl) ? (
                  <img 
                    src={selectedDocument?.fileUrl} 
                    alt={selectedDocument?.fileName || 'Document'}
                    className="max-w-full max-h-[500px] rounded-lg object-contain shadow-lg"
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      target.style.display = 'none';
                      const fallback = target.nextElementSibling;
                      if (fallback) fallback.classList.remove('hidden');
                    }}
                  />
                ) : null
              )}
              {selectedDocument?.fileType !== "pdf" && !isDisplayableUrl(selectedDocument?.fileUrl) && (
                <div className="bg-gradient-to-br from-blue-100 to-blue-200 dark:from-blue-900 dark:to-blue-800 rounded-lg p-8 min-w-[300px] min-h-[200px] flex items-center justify-center">
                  <div className="text-center">
                    <FileImage className="h-16 w-16 mx-auto mb-2 text-blue-500" />
                    <p className="font-medium">{selectedDocument?.fileName}</p>
                    <p className="text-sm text-muted-foreground mt-2">Document stored locally</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Sheet open={detailPanelOpen} onOpenChange={setDetailPanelOpen}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {selectedDocument && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  {selectedDocument.fileType === "pdf" ? <FileText className="h-5 w-5" /> : <FileImage className="h-5 w-5" />}
                  {t('documents.documentDetails')}
                </SheetTitle>
                <SheetDescription>
                  {t('documents.viewDocument')}
                </SheetDescription>
              </SheetHeader>

              <Tabs defaultValue="overview" className="mt-6">
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="overview" data-testid="tab-overview">
                    <Info className="h-4 w-4 mr-1" />
                    {t('common.overview')}
                  </TabsTrigger>
                  <TabsTrigger value="preview" data-testid="tab-preview">
                    <Eye className="h-4 w-4 mr-1" />
                    {t('common.preview')}
                  </TabsTrigger>
                  <TabsTrigger value="history" data-testid="tab-history">
                    <History className="h-4 w-4 mr-1" />
                    {t('common.history')}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="overview" className="space-y-4 mt-4">
                  <Card>
                    <CardContent className="pt-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">{t('documents.documentName')}</span>
                        <span className="font-medium text-right max-w-48 truncate">{selectedDocument.fileName}</span>
                      </div>
                      <Separator />
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">{t('common.type')}</span>
                        <Badge variant="secondary">{shipperCategoryLabels[selectedDocument.category] || documentCategoryLabels[selectedDocument.category]}</Badge>
                      </div>
                      <Separator />
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">{t('documents.fileSize')}</span>
                        <span>{formatFileSize(selectedDocument.fileSize)}</span>
                      </div>
                      <Separator />
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">{t('documents.version')}</span>
                        <span>v{selectedDocument.version}</span>
                      </div>
                      <Separator />
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">{t('common.status')}</span>
                        {getStatusBadge(selectedDocument.status)}
                      </div>
                      <Separator />
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">{t('documents.verified')}</span>
                        {selectedDocument.isVerified ? (
                          <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 no-default-hover-elevate">{t('documents.verified')}</Badge>
                        ) : (
                          <Badge variant="outline">{t('common.pending')}</Badge>
                        )}
                      </div>
                      {selectedDocument.loadId && (
                        <>
                          <Separator />
                          <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">{t('loads.title')}</span>
                            <span className="font-medium">{selectedDocument.loadId}</span>
                          </div>
                        </>
                      )}
                      <Separator />
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">{t('documents.uploadedBy')}</span>
                        <span>{selectedDocument.uploadedBy}</span>
                      </div>
                      <Separator />
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">{t('documents.uploadedOn')}</span>
                        <span>{formatDate(selectedDocument.uploadedDate)}</span>
                      </div>
                      {selectedDocument.expiryDate && (
                        <>
                          <Separator />
                          <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">{t('documents.expiryDate')}</span>
                            <span className={selectedDocument.status !== "active" ? "text-destructive" : ""}>
                              {formatDate(selectedDocument.expiryDate)}
                            </span>
                          </div>
                        </>
                      )}
                    </CardContent>
                  </Card>

                  {selectedDocument.tags.length > 0 && (
                    <div className="space-y-2">
                      <Label>{t('documents.tags')}</Label>
                      <div className="flex flex-wrap gap-2">
                        {selectedDocument.tags.map(tag => (
                          <Badge key={tag} variant="outline">{tag}</Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedDocument.notes && (
                    <div className="space-y-2">
                      <Label>{t('common.notes')}</Label>
                      <p className="text-sm text-muted-foreground p-3 bg-muted rounded-md">
                        {selectedDocument.notes}
                      </p>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2 pt-4">
                    <Button onClick={() => handleView(selectedDocument)} data-testid="button-panel-view">
                      <Eye className="h-4 w-4 mr-2" />
                      {t('common.view')}
                    </Button>
                    <Button variant="outline" onClick={() => handleDownload(selectedDocument)} data-testid="button-panel-download">
                      <Download className="h-4 w-4 mr-2" />
                      {t('common.download')}
                    </Button>
                    {!selectedDocument.isVerified && (
                      <Button 
                        variant="outline" 
                        className="col-span-2"
                        onClick={() => handleVerify(selectedDocument)}
                        data-testid="button-verify"
                      >
                        <CheckCircle className="h-4 w-4 mr-2" />
                        {t('documents.markVerified')}
                      </Button>
                    )}
                    <Button 
                      variant="destructive" 
                      className="col-span-2"
                      onClick={() => handleDelete(selectedDocument)}
                      data-testid="button-panel-delete"
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      {t('documents.deleteDocument')}
                    </Button>
                  </div>
                </TabsContent>

                <TabsContent value="preview" className="mt-4">
                  <div className="bg-muted rounded-lg min-h-[300px] flex flex-col items-center justify-center overflow-hidden">
                    {selectedDocument.fileType === "pdf" ? (
                      isDisplayableUrl(selectedDocument.fileUrl) ? (
                        <iframe 
                          src={`${selectedDocument.fileUrl}?filename=${encodeURIComponent(selectedDocument.fileName)}`} 
                          className="w-full h-[400px] border-0"
                          title={selectedDocument.fileName}
                        />
                      ) : (
                        <div className="text-center p-8">
                          <FileText className="h-16 w-16 mx-auto mb-4 text-red-500" />
                          <p className="font-medium">{selectedDocument.fileName}</p>
                          <p className="text-sm text-muted-foreground mb-4">{formatFileSize(selectedDocument.fileSize)}</p>
                          <Button onClick={() => handleView(selectedDocument)}>
                            <Eye className="h-4 w-4 mr-2" />
                            {t('documents.viewDocument')}
                          </Button>
                        </div>
                      )
                    ) : (
                      isDisplayableUrl(selectedDocument.fileUrl) ? (
                        <div className="w-full p-4">
                          <img 
                            src={`${selectedDocument.fileUrl}?filename=${encodeURIComponent(selectedDocument.fileName)}`} 
                            alt={selectedDocument.fileName}
                            className="max-w-full max-h-[400px] mx-auto rounded-lg object-contain"
                            onError={(e) => {
                              const target = e.target as HTMLImageElement;
                              target.style.display = 'none';
                              const fallback = target.parentElement?.querySelector('.fallback-view') as HTMLElement;
                              if (fallback) fallback.classList.remove('hidden');
                            }}
                          />
                          <div className="fallback-view hidden text-center py-8">
                            <FileImage className="h-16 w-16 mx-auto mb-4 text-blue-500" />
                            <p className="font-medium">{selectedDocument.fileName}</p>
                            <p className="text-sm text-muted-foreground mb-4">Click below to view this document</p>
                            <Button onClick={() => handleView(selectedDocument)}>
                              <Eye className="h-4 w-4 mr-2" />
                              {t('documents.openInNewTab', { defaultValue: 'Open in New Tab' })}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="text-center p-8">
                          <FileImage className="h-16 w-16 mx-auto mb-4 text-blue-500" />
                          <p className="font-medium">{selectedDocument.fileName}</p>
                          <p className="text-sm text-muted-foreground mb-4">{formatFileSize(selectedDocument.fileSize)}</p>
                          <Button onClick={() => handleView(selectedDocument)}>
                            <Eye className="h-4 w-4 mr-2" />
                            {t('documents.viewDocument')}
                          </Button>
                        </div>
                      )
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="history" className="mt-4">
                  <div className="space-y-4">
                    <div className="flex items-start gap-3 p-3 bg-muted rounded-lg">
                      <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <Clock className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium text-sm">{t('documents.version')} {selectedDocument.version} ({t('common.current')})</p>
                        <p className="text-xs text-muted-foreground">
                          {t('documents.uploadedBy')} {selectedDocument.uploadedBy} {t('common.on')} {formatDate(selectedDocument.uploadedDate)}
                        </p>
                      </div>
                    </div>
                    
                    {selectedDocument.previousVersions?.map(version => (
                      <div key={version.version} className="flex items-start gap-3 p-3 border rounded-lg">
                        <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                          <History className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div>
                          <p className="font-medium text-sm">{t('documents.version')} {version.version}</p>
                          <p className="text-xs text-muted-foreground">
                            {version.fileName} - {formatDate(version.uploadedDate)}
                          </p>
                        </div>
                      </div>
                    ))}

                    {!selectedDocument.previousVersions?.length && selectedDocument.version === 1 && (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        {t('documents.originalVersion')}
                      </p>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Expiring Documents Dialog */}
      <Dialog open={expiringViewOpen} onOpenChange={setExpiringViewOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" />
              {t('documents.expiringDocuments')}
            </DialogTitle>
            <DialogDescription>
              Auto-detected documents with expiry dates that need your attention
            </DialogDescription>
          </DialogHeader>
          
          <ScrollArea className="flex-1 pr-4">
            <div className="space-y-6">
              {/* Expired Documents Section */}
              {expiredDocs.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="h-3 w-3 rounded-full bg-red-500" />
                    <h3 className="font-semibold text-red-600 dark:text-red-400">
                      Expired Documents ({expiredDocs.length})
                    </h3>
                  </div>
                  <div className="space-y-2">
                    {expiredDocs.map((doc) => {
                      const rawDays = doc.expiryDate ? getDaysUntilExpiry(doc.expiryDate) : null;
                      const daysAgo = rawDays !== null ? Math.abs(rawDays) : 0;
                      const folder = documentFolders[doc.category];
                      const IconComponent = folder?.icon || FileText;
                      
                      return (
                        <Card key={doc.documentId} className="border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-900/10">
                          <CardContent className="p-4">
                            <div className="flex items-center gap-4">
                              <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${folder?.bgColor || 'bg-gray-100'}`}>
                                <IconComponent className={`h-5 w-5 ${folder?.color || 'text-gray-600'}`} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-sm truncate">{doc.fileName}</p>
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                  <span>{shipperCategoryLabels[doc.category] || doc.category}</span>
                                  {doc.loadId && (
                                    <>
                                      <span>•</span>
                                      <span>{doc.loadId}</span>
                                    </>
                                  )}
                                </div>
                              </div>
                              <div className="text-right">
                                <Badge variant="destructive" className="mb-1">
                                  {t('documents.expired')}
                                </Badge>
                                <p className="text-xs text-red-600 dark:text-red-400">
                                  <Calendar className="h-3 w-3 inline mr-1" />
                                  {doc.expiryDate && formatDate(doc.expiryDate)}
                                </p>
                                <p className="text-xs text-red-500 font-medium">
                                  {daysAgo} day{daysAgo !== 1 ? 's' : ''} ago
                                </p>
                              </div>
                              <Button 
                                variant="outline" 
                                size="sm"
                                onClick={() => {
                                  setSelectedDocument(doc);
                                  setDetailPanelOpen(true);
                                  setExpiringViewOpen(false);
                                }}
                                data-testid={`button-view-expired-${doc.documentId}`}
                              >
                                <Eye className="h-4 w-4" />
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Expiring Soon Documents Section */}
              {expiringDocs.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="h-3 w-3 rounded-full bg-amber-500" />
                    <h3 className="font-semibold text-amber-600 dark:text-amber-400">
                      Expiring Soon ({expiringDocs.length})
                    </h3>
                  </div>
                  <div className="space-y-2">
                    {expiringDocs
                      .sort((a, b) => {
                        const aDays = a.expiryDate ? (getDaysUntilExpiry(a.expiryDate) ?? Infinity) : Infinity;
                        const bDays = b.expiryDate ? (getDaysUntilExpiry(b.expiryDate) ?? Infinity) : Infinity;
                        return aDays - bDays;
                      })
                      .map((doc) => {
                        const rawDaysLeft = doc.expiryDate ? getDaysUntilExpiry(doc.expiryDate) : null;
                        const daysLeft = rawDaysLeft ?? 0;
                        const folder = documentFolders[doc.category];
                        const IconComponent = folder?.icon || FileText;
                        const isUrgent = daysLeft <= 7;
                        const isWarning = daysLeft <= 14;
                        
                        return (
                          <Card 
                            key={doc.documentId} 
                            className={
                              isUrgent 
                                ? "border-orange-300 dark:border-orange-700 bg-orange-50/50 dark:bg-orange-900/10"
                                : isWarning
                                  ? "border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-900/10"
                                  : "border-yellow-200 dark:border-yellow-800 bg-yellow-50/50 dark:bg-yellow-900/10"
                            }
                          >
                            <CardContent className="p-4">
                              <div className="flex items-center gap-4">
                                <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${folder?.bgColor || 'bg-gray-100'}`}>
                                  <IconComponent className={`h-5 w-5 ${folder?.color || 'text-gray-600'}`} />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="font-medium text-sm truncate">{doc.fileName}</p>
                                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <span>{shipperCategoryLabels[doc.category] || doc.category}</span>
                                    {doc.loadId && (
                                      <>
                                        <span>•</span>
                                        <span>{doc.loadId}</span>
                                      </>
                                    )}
                                  </div>
                                </div>
                                <div className="text-right">
                                  <Badge 
                                    variant="outline" 
                                    className={
                                      isUrgent 
                                        ? "border-orange-400 text-orange-600 dark:text-orange-400 mb-1"
                                        : "border-amber-400 text-amber-600 dark:text-amber-400 mb-1"
                                    }
                                  >
                                    {daysLeft} day{daysLeft !== 1 ? 's' : ''} left
                                  </Badge>
                                  <p className="text-xs text-muted-foreground">
                                    <Calendar className="h-3 w-3 inline mr-1" />
                                    {doc.expiryDate && formatDate(doc.expiryDate)}
                                  </p>
                                </div>
                                <Button 
                                  variant="outline" 
                                  size="sm"
                                  onClick={() => {
                                    setSelectedDocument(doc);
                                    setDetailPanelOpen(true);
                                    setExpiringViewOpen(false);
                                  }}
                                  data-testid={`button-view-expiring-${doc.documentId}`}
                                >
                                  <Eye className="h-4 w-4" />
                                </Button>
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* No expiring documents */}
              {expiredDocs.length === 0 && expiringDocs.length === 0 && (
                <div className="text-center py-8">
                  <CheckCircle className="h-12 w-12 mx-auto mb-4 text-green-500" />
                  <p className="font-medium text-green-600 dark:text-green-400">All documents are up to date!</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    No documents require immediate attention
                  </p>
                </div>
              )}

              {/* Auto-Detection Info */}
              <Card className="bg-muted/50">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <Info className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-sm">Auto-Expiry Detection</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        The system automatically monitors document expiry dates and creates alerts when documents are within 30 days of expiration. 
                        Documents with past expiry dates are marked as expired.
                      </p>
                      <div className="flex gap-4 mt-3 text-xs">
                        <div className="flex items-center gap-1.5">
                          <div className="h-2.5 w-2.5 rounded-full bg-red-500" />
                          <span>Expired</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div className="h-2.5 w-2.5 rounded-full bg-orange-500" />
                          <span>≤7 days</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                          <span>≤14 days</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div className="h-2.5 w-2.5 rounded-full bg-yellow-500" />
                          <span>≤30 days</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </ScrollArea>

          <div className="flex justify-end gap-2 pt-4 border-t mt-4">
            <Button variant="outline" onClick={() => setExpiringViewOpen(false)}>
              {t('common.close')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
