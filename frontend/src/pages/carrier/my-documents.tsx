import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  FileText,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  Upload,
  Calendar,
  Download,
  Eye,
  Trash2,
  File,
  X,
  Loader2,
  FolderOpen,
  Folder,
  ChevronRight,
  ChevronDown,
  Truck,
  User,
  Package
} from "lucide-react";
import { format, differenceInDays } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface Document {
  id: string;
  documentType: string;
  fileName: string;
  fileUrl: string;
  fileSize?: number;
  expiryDate: string | null;
  isVerified: boolean;
  createdAt: string;
  verificationStatus?: "pending" | "approved" | "rejected";
  rejectionReason?: string;
  driverId?: string | null;
  truckId?: string | null;
}

interface ShipmentDocument {
  id: string;
  documentType: string;
  fileName: string;
  fileUrl: string;
  status: string;
  createdAt: string;
}

interface ShipmentWithDocs {
  id: string;
  loadNumber: number;
  status: string;
  documents: ShipmentDocument[];
}

interface ExpiryData {
  expired: Document[];
  expiringSoon: Document[];
  healthy: Document[];
  summary: {
    totalDocs: number;
    expiredCount: number;
    expiringSoonCount: number;
    healthyCount: number;
  };
}

const documentTypeLabels: Record<string, string> = {
  rc: "Registration Certificate (RC)",
  insurance: "Vehicle Insurance",
  fitness: "Fitness Certificate",
  license: "Driving License",
  puc: "PUC Certificate",
  permit: "Road Permit",
  pan_card: "PAN Card",
  aadhar: "Aadhar Card",
  aadhaar: "Aadhaar Card",
  pod: "Proof of Delivery",
  invoice: "Invoice",
  lr_consignment: "LR/Consignment Note",
  eway_bill: "E-Way Bill",
  weighment_slip: "Weighment Slip",
  other: "Other Document",
};

const documentCategories = {
  truck: ["rc", "insurance", "fitness", "puc", "permit"],
  driver: ["license", "pan_card", "aadhar", "aadhaar"],
  trip: ["pod", "invoice", "lr_consignment", "eway_bill", "weighment_slip"],
  official: ["incorporation", "trade_license", "address_proof", "pan", "gstin", "tan", "gst", "void_cheque", "tds_declaration", "fleet_proof"],
};

function formatFileSize(bytes?: number): string {
  if (!bytes) return "Unknown size";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// Component to load images from authenticated /objects/ routes
function AuthenticatedImage({ 
  src, 
  alt, 
  className, 
  testId,
  onLoadError 
}: { 
  src: string; 
  alt: string; 
  className?: string; 
  testId?: string;
  onLoadError?: () => void;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let isMounted = true;
    let currentBlobUrl: string | null = null;
    
    async function fetchImage() {
      try {
        setLoading(true);
        setError(false);
        setBlobUrl(null);
        
        // If it's a data URL, use directly
        if (src.startsWith('data:')) {
          if (isMounted) {
            setBlobUrl(src);
            setLoading(false);
          }
          return;
        }
        
        // If it's an asset URL, use directly
        if (src.includes('/assets/')) {
          if (isMounted) {
            setBlobUrl(src);
            setLoading(false);
          }
          return;
        }
        
        const response = await fetch(src, {
          credentials: 'include',
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        // Verify content type is an image
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.startsWith('image/')) {
          throw new Error(`Invalid content type: ${contentType}`);
        }
        
        const blob = await response.blob();
        
        // Double-check blob type
        if (!blob.type.startsWith('image/') && blob.type !== '') {
          throw new Error(`Invalid blob type: ${blob.type}`);
        }
        
        if (isMounted) {
          currentBlobUrl = URL.createObjectURL(blob);
          setBlobUrl(currentBlobUrl);
          setLoading(false);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error('Error loading authenticated image:', src, 'Error:', errorMessage);
        if (isMounted) {
          setError(true);
          setLoading(false);
          onLoadError?.();
        }
      }
    }
    
    if (src) {
      fetchImage();
    } else {
      setLoading(false);
      setError(true);
      onLoadError?.();
    }
    
    return () => {
      isMounted = false;
      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
      }
    };
  }, [src, onLoadError]);

  if (loading) {
    return (
      <div className={`${className || ''} flex items-center justify-center bg-muted`}>
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !blobUrl) {
    return null;
  }

  return (
    <img 
      src={blobUrl} 
      alt={alt} 
      className={className}
      data-testid={testId}
      onError={() => {
        setError(true);
        onLoadError?.();
      }}
    />
  );
}

// Document Preview component with authenticated image loading
function DocumentPreview({ fileUrl, fileName }: { fileUrl?: string; fileName: string }) {
  const [loadError, setLoadError] = useState(false);
  
  // Reset error state when fileUrl changes
  useEffect(() => {
    setLoadError(false);
  }, [fileUrl]);
  
  // Stable callback reference to prevent unnecessary re-renders
  const handleLoadError = useCallback(() => {
    setLoadError(true);
  }, []);
  
  const isImageUrl = fileUrl && (
    fileUrl.includes("/assets/generated_images/") ||
    fileUrl.endsWith(".png") ||
    fileUrl.endsWith(".jpg") ||
    fileUrl.endsWith(".jpeg") ||
    fileUrl.startsWith("data:image/") ||
    fileUrl.includes("/objects/")
  );

  // Show fallback when no URL, load error, or not an image URL
  if (!fileUrl || loadError || !isImageUrl) {
    return (
      <div className="aspect-[4/3] rounded-lg bg-muted flex items-center justify-center mb-4 overflow-hidden" data-testid="document-preview-fallback">
        <div className="text-center text-muted-foreground flex flex-col items-center justify-center">
          <FileText className="h-16 w-16 mx-auto mb-2 opacity-50" />
          <p className="text-sm">Document Preview</p>
          <p className="text-xs">{fileName}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="aspect-[4/3] rounded-lg bg-muted flex items-center justify-center mb-4 overflow-hidden" data-testid="document-preview-image">
      <AuthenticatedImage
        src={fileUrl}
        alt={fileName}
        className="w-full h-full object-contain"
        testId="img-document-preview"
        onLoadError={handleLoadError}
      />
    </div>
  );
}

export default function MyDocumentsPage() {
  const { user, carrierType } = useAuth();
  const { toast } = useToast();
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [previewDialogOpen, setPreviewDialogOpen] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const [selectedDocType, setSelectedDocType] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [expiryDate, setExpiryDate] = useState("");
  const [selectedDriverId, setSelectedDriverId] = useState("");
  const [selectedTruckId, setSelectedTruckId] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    truck: true,
    driver: false,
    loads: true,
  });
  const [expandedLoads, setExpandedLoads] = useState<Record<string, boolean>>({});
  const [expandedDrivers, setExpandedDrivers] = useState<Record<string, boolean>>({});
  const [expandedTrucks, setExpandedTrucks] = useState<Record<string, boolean>>({});
  const [viewAllDialogOpen, setViewAllDialogOpen] = useState(false);
  const [viewAllFolderName, setViewAllFolderName] = useState("");
  const [viewAllDocuments, setViewAllDocuments] = useState<Document[]>([]);

  const toggleDriver = (driverId: string) => {
    setExpandedDrivers(prev => ({ ...prev, [driverId]: !prev[driverId] }));
  };

  const openViewAllDialog = (folderName: string, documents: Document[]) => {
    setViewAllFolderName(folderName);
    setViewAllDocuments(documents);
    setViewAllDialogOpen(true);
  };

  const toggleTruck = (truckId: string) => {
    setExpandedTrucks(prev => ({ ...prev, [truckId]: !prev[truckId] }));
  };

  const { data, isLoading, error } = useQuery<ExpiryData>({
    queryKey: ["/api/carrier/documents/expiring"],
    enabled: !!user && user.role === "carrier",
    staleTime: 5000,
    refetchOnWindowFocus: true,
  });

  const { data: shipmentsData, refetch: refetchShipments } = useQuery<any[]>({
    queryKey: ["/api/shipments/tracking"],
    enabled: !!user && user.role === "carrier",
    staleTime: 2000,
    refetchInterval: 5000, // Poll every 5 seconds for real-time updates
    refetchOnWindowFocus: true,
  });

  // Fetch drivers to get their documents (license, aadhaar images)
  const { data: driversData } = useQuery<any[]>({
    queryKey: ["/api/drivers"],
    enabled: !!user && user.role === "carrier",
    staleTime: 5000,
    refetchOnWindowFocus: true,
  });

  // Fetch trucks to get their documents (RC, insurance, etc.)
  const { data: trucksData } = useQuery<any[]>({
    queryKey: ["/api/trucks"],
    enabled: !!user && user.role === "carrier",
    staleTime: 5000,
    refetchOnWindowFocus: true,
  });

  // Fetch carrier verification to get verification documents with their status
  const { data: verificationData } = useQuery<{
    id: string;
    status: string;
    documents?: Array<{
      id: string;
      documentType: string;
      fileName: string;
      fileUrl: string;
      status: string;
      rejectionReason?: string;
      createdAt: string;
    }>;
  } | null>({
    queryKey: ["/api/carrier/verification"],
    enabled: !!user && user.role === "carrier",
    staleTime: 5000,
    refetchOnWindowFocus: true,
  });

  const uploadMutation = useMutation({
    mutationFn: async (docData: { documentType: string; fileName: string; fileUrl: string; fileSize: number; expiryDate: string | null; driverId?: string | null; truckId?: string | null }) => {
      return apiRequest("POST", "/api/carrier/documents", docData);
    },
    onSuccess: () => {
      toast({
        title: "Document Uploaded",
        description: "Your document has been uploaded successfully.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/carrier/documents/expiring"] });
      setUploadDialogOpen(false);
      resetUploadForm();
    },
    onError: () => {
      toast({
        title: "Upload Failed",
        description: "Failed to upload document. Please try again.",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (docId: string) => {
      return apiRequest("DELETE", `/api/carrier/documents/${docId}`);
    },
    onSuccess: () => {
      toast({
        title: "Document Deleted",
        description: "The document has been removed.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/carrier/documents/expiring"] });
      setPreviewDialogOpen(false);
      setSelectedDocument(null);
    },
    onError: () => {
      toast({
        title: "Delete Failed",
        description: "Failed to delete document. Please try again.",
        variant: "destructive",
      });
    },
  });

  const resetUploadForm = () => {
    setSelectedDocType("");
    setSelectedFile(null);
    setExpiryDate("");
    setSelectedDriverId("");
    setSelectedTruckId("");
  };

  // Helper to check if document type is for drivers
  const isDriverDocType = (docType: string) => 
    ["license", "pan_card", "aadhar", "aadhaar"].includes(docType);

  // Helper to check if document type is for trucks
  const isTruckDocType = (docType: string) => 
    ["rc", "insurance", "fitness", "puc", "permit"].includes(docType);

  // Helper to get owner info for a document (driver name or truck registration)
  const getDocumentOwnerInfo = (doc: Document): string => {
    if (doc.driverId && driversData) {
      const driver = driversData.find((d: any) => d.id === doc.driverId);
      if (driver) return `(${driver.name})`;
    }
    if (doc.truckId && trucksData) {
      const truck = trucksData.find((t: any) => t.id === doc.truckId);
      if (truck) return `(${truck.registrationNumber})`;
    }
    return "";
  };

  const handleUpload = async () => {
    if (!selectedDocType || !selectedFile) {
      toast({
        title: "Missing Information",
        description: "Please select a document type and file.",
        variant: "destructive",
      });
      return;
    }

    // For fleet/enterprise carriers, require driver/truck selection for relevant doc types
    if (carrierType === "enterprise") {
      if (isDriverDocType(selectedDocType) && !selectedDriverId && driversData && driversData.length > 0) {
        toast({
          title: "Missing Information",
          description: "Please select which driver this document belongs to.",
          variant: "destructive",
        });
        return;
      }
      if (isTruckDocType(selectedDocType) && !selectedTruckId && trucksData && trucksData.length > 0) {
        toast({
          title: "Missing Information",
          description: "Please select which truck this document belongs to.",
          variant: "destructive",
        });
        return;
      }
    }

    const reader = new FileReader();
    reader.onload = () => {
      const base64Url = reader.result as string;
      uploadMutation.mutate({
        documentType: selectedDocType,
        fileName: selectedFile.name,
        fileUrl: base64Url,
        fileSize: selectedFile.size,
        expiryDate: expiryDate || null,
        driverId: isDriverDocType(selectedDocType) ? (selectedDriverId || null) : null,
        truckId: isTruckDocType(selectedDocType) ? (selectedTruckId || null) : null,
      });
    };
    reader.onerror = () => {
      toast({
        title: "File Read Error",
        description: "Failed to read the file. Please try again.",
        variant: "destructive",
      });
    };
    reader.readAsDataURL(selectedFile);
  };

  const handlePreview = (doc: Document) => {
    setSelectedDocument(doc);
    setPreviewDialogOpen(true);
  };

  const handleDelete = (docId: string) => {
    deleteMutation.mutate(docId);
  };

  const toggleFolder = (folder: string) => {
    setExpandedFolders(prev => ({ ...prev, [folder]: !prev[folder] }));
  };

  const toggleLoad = (loadId: string) => {
    setExpandedLoads(prev => ({ ...prev, [loadId]: !prev[loadId] }));
  };

  if (carrierType === undefined) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-48" data-testid="skeleton-title" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Skeleton className="h-24" data-testid="skeleton-stat-1" />
          <Skeleton className="h-24" data-testid="skeleton-stat-2" />
          <Skeleton className="h-24" data-testid="skeleton-stat-3" />
          <Skeleton className="h-24" data-testid="skeleton-stat-4" />
        </div>
        <Skeleton className="h-64" data-testid="skeleton-content" />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-48" data-testid="skeleton-title" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Skeleton className="h-24" data-testid="skeleton-stat-1" />
          <Skeleton className="h-24" data-testid="skeleton-stat-2" />
          <Skeleton className="h-24" data-testid="skeleton-stat-3" />
          <Skeleton className="h-24" data-testid="skeleton-stat-4" />
        </div>
        <Skeleton className="h-64" data-testid="skeleton-content" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Alert variant="destructive" data-testid="alert-error">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>Failed to load documents. Please try again.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const { expired, expiringSoon, healthy, summary } = data || { 
    expired: [], 
    expiringSoon: [], 
    healthy: [], 
    summary: { totalDocs: 0, expiredCount: 0, expiringSoonCount: 0, healthyCount: 0 } 
  };

  const allDocuments = [...expired, ...expiringSoon, ...healthy];
  
  // Helper to extract URL from JSON object or string
  const extractFileUrl = (urlData: any): string | null => {
    if (!urlData) return null;
    if (typeof urlData === 'string') {
      try {
        const parsed = JSON.parse(urlData);
        return parsed.path || parsed.url || urlData;
      } catch {
        return urlData;
      }
    }
    if (typeof urlData === 'object' && urlData.path) {
      return urlData.path;
    }
    return null;
  };

  // Convert driver documents (license, aadhaar images stored on driver records) to Document format
  // Default to isVerified: false - verification status will be merged from verification table
  const driverDocumentsFromDrivers: Document[] = [];
  (driversData || []).forEach((driver: any) => {
    const driverLicenseUrl = extractFileUrl(driver.licenseImageUrl);
    if (driverLicenseUrl) {
      driverDocumentsFromDrivers.push({
        id: `driver-license-${driver.id}`,
        documentType: "license",
        fileName: `${driver.name} - Driving License`,
        fileUrl: driverLicenseUrl,
        fileSize: undefined,
        expiryDate: driver.licenseExpiry || null,
        isVerified: false,
        createdAt: driver.createdAt || new Date().toISOString(),
      });
    }
    const driverAadhaarUrl = extractFileUrl(driver.aadhaarImageUrl);
    if (driverAadhaarUrl) {
      driverDocumentsFromDrivers.push({
        id: `driver-aadhaar-${driver.id}`,
        documentType: "aadhaar",
        fileName: `${driver.name} - Aadhaar Card${driver.aadhaarNumber ? ` (${driver.aadhaarNumber})` : ''}`,
        fileUrl: driverAadhaarUrl,
        fileSize: undefined,
        expiryDate: null,
        isVerified: false,
        createdAt: driver.createdAt || new Date().toISOString(),
      });
    }
  });

  // Convert truck documents (RC, insurance, etc. stored on truck records) to Document format
  // Group truck documents by license plate for hierarchical display
  const truckDocumentsFromTrucks: Document[] = [];
  const truckDocumentsByPlate: Record<string, { truckId: string; licensePlate: string; documents: Document[] }> = {};
  
  (trucksData || []).forEach((truck: any) => {
    const truckDocs: Document[] = [];
    const plateLabel = truck.licensePlate || truck.registrationNumber || `Truck ${truck.id}`;
    
    // Default to isVerified: false - verification status will be merged from verification table
    const rcUrl = extractFileUrl(truck.rcDocumentUrl);
    if (rcUrl) {
      const doc = {
        id: `truck-rc-${truck.id}`,
        documentType: "rc",
        fileName: "Registration Certificate",
        fileUrl: rcUrl,
        fileSize: undefined,
        expiryDate: truck.rcExpiry || null,
        isVerified: false,
        createdAt: truck.createdAt || new Date().toISOString(),
      };
      truckDocumentsFromTrucks.push(doc);
      truckDocs.push(doc);
    }
    const insuranceUrl = extractFileUrl(truck.insuranceDocumentUrl);
    if (insuranceUrl) {
      const doc = {
        id: `truck-insurance-${truck.id}`,
        documentType: "insurance",
        fileName: "Insurance",
        fileUrl: insuranceUrl,
        fileSize: undefined,
        expiryDate: truck.insuranceExpiry || null,
        isVerified: false,
        createdAt: truck.createdAt || new Date().toISOString(),
      };
      truckDocumentsFromTrucks.push(doc);
      truckDocs.push(doc);
    }
    const fitnessUrl = extractFileUrl(truck.fitnessDocumentUrl);
    if (fitnessUrl) {
      const doc = {
        id: `truck-fitness-${truck.id}`,
        documentType: "fitness",
        fileName: "Fitness Certificate",
        fileUrl: fitnessUrl,
        fileSize: undefined,
        expiryDate: truck.fitnessExpiry || null,
        isVerified: false,
        createdAt: truck.createdAt || new Date().toISOString(),
      };
      truckDocumentsFromTrucks.push(doc);
      truckDocs.push(doc);
    }
    const permitUrl = extractFileUrl(truck.permitDocumentUrl);
    if (permitUrl) {
      const doc = {
        id: `truck-permit-${truck.id}`,
        documentType: "permit",
        fileName: "State Permit",
        fileUrl: permitUrl,
        fileSize: undefined,
        expiryDate: truck.permitExpiry || null,
        isVerified: false,
        createdAt: truck.createdAt || new Date().toISOString(),
      };
      truckDocumentsFromTrucks.push(doc);
      truckDocs.push(doc);
    }
    const pucUrl = extractFileUrl(truck.pucDocumentUrl);
    if (pucUrl) {
      const doc = {
        id: `truck-puc-${truck.id}`,
        documentType: "puc",
        fileName: "PUC Certificate",
        fileUrl: pucUrl,
        fileSize: undefined,
        expiryDate: truck.pucExpiry || null,
        isVerified: false,
        createdAt: truck.createdAt || new Date().toISOString(),
      };
      truckDocumentsFromTrucks.push(doc);
      truckDocs.push(doc);
    }
    
    // Always add truck to folder structure, even if no documents yet
    truckDocumentsByPlate[plateLabel] = {
      truckId: truck.id,
      licensePlate: plateLabel,
      documents: truckDocs
    };
  });

  // Also add documents from the documents table (uploaded via add-truck form) to truckDocumentsByPlate
  // These documents have truckId set but are not stored on the truck record itself
  allDocuments.forEach((doc) => {
    if (doc.truckId && documentCategories.truck.includes(doc.documentType)) {
      // Find the truck this document belongs to
      const truck = (trucksData || []).find((t: any) => t.id === doc.truckId);
      if (truck) {
        const plateLabel = truck.licensePlate || truck.registrationNumber || `Truck ${truck.id}`;
        // Check if this truck exists in our folder structure
        if (truckDocumentsByPlate[plateLabel]) {
          // Check if this document is not already in the list (avoid duplicates)
          const existingDoc = truckDocumentsByPlate[plateLabel].documents.find(
            (d) => d.id === doc.id || (d.documentType === doc.documentType && d.fileUrl === doc.fileUrl)
          );
          if (!existingDoc) {
            truckDocumentsByPlate[plateLabel].documents.push(doc);
          }
        }
      }
    }
  });

  // Create maps for verification document status - by fileUrl (most unique), fileName, and documentType as fallback
  const verificationByUrl: Record<string, { status: string; rejectionReason?: string }> = {};
  const verificationByFileName: Record<string, { status: string; rejectionReason?: string }> = {};
  const verificationByType: Record<string, { status: string; rejectionReason?: string }> = {};
  
  if (verificationData?.documents) {
    verificationData.documents.forEach(doc => {
      // Primary key: fileUrl (most unique)
      if (doc.fileUrl) {
        verificationByUrl[doc.fileUrl] = {
          status: doc.status,
          rejectionReason: doc.rejectionReason
        };
      }
      // Secondary key: fileName (good for matching)
      if (doc.fileName) {
        verificationByFileName[doc.fileName] = {
          status: doc.status,
          rejectionReason: doc.rejectionReason
        };
      }
      // Fallback: documentType (only for single-document types like business docs)
      verificationByType[doc.documentType] = {
        status: doc.status,
        rejectionReason: doc.rejectionReason
      };
    });
  }

  // Helper function to merge verification status with documents
  // Uses hierarchical matching: fileUrl > fileName > documentType (for official docs only)
  const mergeVerificationStatus = (docs: Document[]): Document[] => {
    return docs.map(doc => {
      // Try to find verification by most specific match first
      const verificationInfo = 
        verificationByUrl[doc.fileUrl] || 
        verificationByFileName[doc.fileName] || 
        (documentCategories.official.includes(doc.documentType) ? verificationByType[doc.documentType] : null);
      
      if (verificationInfo) {
        return {
          ...doc,
          verificationStatus: verificationInfo.status as "pending" | "approved" | "rejected",
          rejectionReason: verificationInfo.rejectionReason,
          isVerified: verificationInfo.status === "approved"
        };
      }
      // If no verification record found, explicitly set to pending for clear UI state
      return {
        ...doc,
        verificationStatus: "pending" as const,
        isVerified: false
      };
    });
  };

  // Merge documents from documents table with driver/truck documents
  const truckDocsFromTable = allDocuments.filter(d => documentCategories.truck.includes(d.documentType));
  const driverDocsFromTable = allDocuments.filter(d => documentCategories.driver.includes(d.documentType));
  
  const truckDocs = mergeVerificationStatus([...truckDocsFromTable, ...truckDocumentsFromTrucks]);
  const driverDocs = mergeVerificationStatus([...driverDocsFromTable, ...driverDocumentsFromDrivers]);
  const tripDocs = mergeVerificationStatus(allDocuments.filter(d => documentCategories.trip.includes(d.documentType)));

  // Get all carrier shipments - backend already filters by current carrier
  const carrierShipments = shipmentsData || [];

  // Group shipments by load number - show all loads, with or without documents
  const shipmentsByLoad: Record<number, ShipmentWithDocs> = {};
  carrierShipments.forEach((s: any) => {
    // Use shipperLoadNumber from the load object (this is the LD-XXX number)
    const loadNum = s.load?.shipperLoadNumber || s.load?.loadNumber || s.loadNumber;
    if (loadNum) {
      // Only add if not already exists, or if this one has more documents
      const existingDocs = shipmentsByLoad[loadNum]?.documents?.length || 0;
      const newDocs = s.documents?.length || 0;
      if (!shipmentsByLoad[loadNum] || newDocs > existingDocs) {
        shipmentsByLoad[loadNum] = {
          id: s.id,
          loadNumber: loadNum,
          status: s.status,
          documents: s.documents || [],
        };
      }
    }
  });

  const renderDocument = (doc: Document, compact = false) => {
    const daysUntilExpiry = doc.expiryDate 
      ? differenceInDays(new Date(doc.expiryDate), new Date()) 
      : null;
    
    const isExpired = daysUntilExpiry !== null && daysUntilExpiry < 0;
    const isExpiringSoon = daysUntilExpiry !== null && daysUntilExpiry >= 0 && daysUntilExpiry <= 30;

    return (
      <div 
        key={doc.id}
        className={`p-3 rounded-lg border cursor-pointer hover-elevate ${
          isExpired 
            ? "border-red-200 bg-red-50 dark:bg-red-950/20" 
            : isExpiringSoon 
              ? "border-amber-200 bg-amber-50 dark:bg-amber-950/20"
              : ""
        }`}
        onClick={() => handlePreview(doc)}
        data-testid={`card-document-${doc.id}`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className="flex-shrink-0">
              {isExpired ? (
                <XCircle className="h-4 w-4 text-red-500" />
              ) : doc.verificationStatus === "rejected" ? (
                <XCircle className="h-4 w-4 text-red-500" />
              ) : doc.isVerified || doc.verificationStatus === "approved" ? (
                <CheckCircle className="h-4 w-4 text-green-500" />
              ) : (
                <Clock className="h-4 w-4 text-amber-500" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm truncate">
                {documentTypeLabels[doc.documentType] || doc.documentType}
              </p>
              <p className="text-xs text-muted-foreground truncate">{doc.fileName}</p>
              {doc.verificationStatus === "rejected" && doc.rejectionReason && (
                <p className="text-xs text-red-500 truncate mt-0.5">Rejected: {doc.rejectionReason}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {isExpired && (
              <Badge variant="destructive" className="text-xs">
                Expired {Math.abs(daysUntilExpiry!)} days ago
              </Badge>
            )}
            {isExpiringSoon && !isExpired && (
              <Badge className="bg-amber-500 text-white text-xs no-default-hover-elevate no-default-active-elevate">
                {daysUntilExpiry === 0 ? "Expires today" : `${daysUntilExpiry} days left`}
              </Badge>
            )}
            {doc.verificationStatus === "rejected" && (
              <Badge variant="destructive" className="text-xs">Rejected</Badge>
            )}
            {!isExpired && !isExpiringSoon && doc.verificationStatus !== "rejected" && (doc.isVerified || doc.verificationStatus === "approved") && (
              <Badge variant="default" className="text-xs">Verified</Badge>
            )}
            {!doc.isVerified && doc.verificationStatus !== "approved" && doc.verificationStatus !== "rejected" && !isExpired && !isExpiringSoon && (
              <Badge variant="secondary" className="text-xs">Pending</Badge>
            )}
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-7 w-7"
              onClick={(e) => {
                e.stopPropagation();
                window.open(doc.fileUrl, "_blank");
              }}
            >
              <Download className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>
    );
  };

  const renderShipmentDocument = (doc: ShipmentDocument) => {
    return (
      <div 
        key={doc.id}
        className="p-3 rounded-lg border cursor-pointer hover-elevate"
        onClick={() => {
          setSelectedDocument({
            id: doc.id,
            documentType: doc.documentType,
            fileName: doc.fileName,
            fileUrl: doc.fileUrl,
            fileSize: undefined,
            expiryDate: null,
            isVerified: doc.status === "approved",
            createdAt: doc.createdAt,
          });
          setPreviewDialogOpen(true);
        }}
        data-testid={`card-shipment-doc-${doc.id}`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm truncate">
                {documentTypeLabels[doc.documentType] || doc.documentType}
              </p>
              <p className="text-xs text-muted-foreground truncate">{doc.fileName}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Badge 
              variant={doc.status === "approved" ? "default" : "secondary"} 
              className="text-xs capitalize"
            >
              {doc.status}
            </Badge>
            <Button 
              variant="ghost" 
              size="icon"
              className="h-7 w-7"
              onClick={(e) => {
                e.stopPropagation();
                window.open(doc.fileUrl, "_blank");
              }}
            >
              <Download className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>
    );
  };

  const FolderSection = ({ 
    title, 
    icon: Icon, 
    folderId, 
    documents, 
    emptyMessage 
  }: { 
    title: string; 
    icon: any; 
    folderId: string; 
    documents: Document[]; 
    emptyMessage: string;
  }) => {
    // Count expiring and expired documents in this folder
    const expiringCount = documents.filter(d => {
      if (!d.expiryDate) return false;
      const days = differenceInDays(new Date(d.expiryDate), new Date());
      return days >= 0 && days <= 30;
    }).length;
    const expiredCount = documents.filter(d => {
      if (!d.expiryDate) return false;
      return differenceInDays(new Date(d.expiryDate), new Date()) < 0;
    }).length;
    const hasAlerts = expiringCount > 0 || expiredCount > 0;

    return (
      <Collapsible 
        open={expandedFolders[folderId]} 
        onOpenChange={() => toggleFolder(folderId)}
      >
        <CollapsibleTrigger className="w-full">
          <div className={`flex items-center gap-2 p-3 rounded-lg hover-elevate border bg-card ${
            expiredCount > 0 ? "border-red-300 dark:border-red-800" : 
            expiringCount > 0 ? "border-amber-300 dark:border-amber-700" : ""
          }`}>
            {expandedFolders[folderId] ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            {expandedFolders[folderId] ? (
              <FolderOpen className="h-5 w-5 text-amber-500" />
            ) : (
              <Folder className="h-5 w-5 text-amber-500" />
            )}
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{title}</span>
            {hasAlerts && (
              <div className="flex items-center gap-1">
                {expiredCount > 0 && (
                  <Badge variant="destructive" className="text-xs">
                    {expiredCount} expired
                  </Badge>
                )}
                {expiringCount > 0 && (
                  <Badge className="bg-amber-500 hover:bg-amber-600 text-white text-xs">
                    {expiringCount} expiring
                  </Badge>
                )}
              </div>
            )}
            <Badge variant="secondary" className="ml-auto text-xs">
              {documents.length}
            </Badge>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ml-6 mt-2 space-y-2 border-l-2 border-muted pl-4">
            {documents.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">{emptyMessage}</p>
            ) : (
              documents.map(doc => renderDocument(doc, true))
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  const LoadsFolderSection = () => {
    const loadNumbers = Object.keys(shipmentsByLoad).map(Number).sort((a, b) => b - a);
    const totalDocs = Object.values(shipmentsByLoad).reduce((sum, s) => sum + s.documents.length, 0);

    return (
      <Collapsible 
        open={expandedFolders.loads} 
        onOpenChange={() => toggleFolder("loads")}
      >
        <CollapsibleTrigger className="w-full">
          <div className="flex items-center gap-2 p-3 rounded-lg hover-elevate border bg-card">
            {expandedFolders.loads ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            {expandedFolders.loads ? (
              <FolderOpen className="h-5 w-5 text-blue-500" />
            ) : (
              <Folder className="h-5 w-5 text-blue-500" />
            )}
            <Package className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">Loads</span>
            <Badge variant="secondary" className="ml-auto text-xs">
              {totalDocs} docs in {loadNumbers.length} loads
            </Badge>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ml-6 mt-2 space-y-2 border-l-2 border-muted pl-4">
            {loadNumbers.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No load documents yet</p>
            ) : (
              loadNumbers.map(loadNum => {
                const shipment = shipmentsByLoad[loadNum];
                const isExpanded = expandedLoads[`load-${loadNum}`];
                return (
                  <Collapsible 
                    key={loadNum}
                    open={isExpanded}
                    onOpenChange={() => toggleLoad(`load-${loadNum}`)}
                  >
                    <CollapsibleTrigger className="w-full">
                      <div className="flex items-center gap-2 p-2 rounded-lg hover-elevate border bg-muted/50">
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        )}
                        {isExpanded ? (
                          <FolderOpen className="h-4 w-4 text-primary" />
                        ) : (
                          <Folder className="h-4 w-4 text-primary" />
                        )}
                        <span className="font-medium text-sm">LD-{String(loadNum).padStart(3, '0')}</span>
                        <Badge variant="outline" className="text-xs ml-2 capitalize">
                          {shipment.status.replace(/_/g, ' ')}
                        </Badge>
                        <Badge variant="secondary" className="ml-auto text-xs">
                          {shipment.documents.length} {shipment.documents.length === 1 ? 'doc' : 'docs'}
                        </Badge>
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="ml-6 mt-2 space-y-2 border-l border-muted pl-3">
                        {shipment.documents.length === 0 ? (
                          <p className="text-sm text-muted-foreground py-2">No documents uploaded yet</p>
                        ) : (
                          shipment.documents.map(doc => renderShipmentDocument(doc))
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  // Group driver documents by driver name for hierarchical display
  const driverDocumentsByName: Record<string, { driverId: string; documents: Document[] }> = {};
  (driversData || []).forEach((driver: any) => {
    const driverDocs: Document[] = [];
    const licenseUrl = extractFileUrl(driver.licenseImageUrl);
    if (licenseUrl) {
      driverDocs.push({
        id: `driver-license-${driver.id}`,
        documentType: "license",
        fileName: "Driving License",
        fileUrl: licenseUrl,
        fileSize: undefined,
        expiryDate: driver.licenseExpiry || null,
        isVerified: false,
        createdAt: driver.createdAt || new Date().toISOString(),
      });
    }
    const aadhaarUrl = extractFileUrl(driver.aadhaarImageUrl);
    if (aadhaarUrl) {
      driverDocs.push({
        id: `driver-aadhaar-${driver.id}`,
        documentType: "aadhaar",
        fileName: `Aadhaar Card${driver.aadhaarNumber ? ` (${driver.aadhaarNumber})` : ''}`,
        fileUrl: aadhaarUrl,
        fileSize: undefined,
        expiryDate: null,
        isVerified: false,
        createdAt: driver.createdAt || new Date().toISOString(),
      });
    }
    // Always add driver to folder structure, even if no documents yet
    driverDocumentsByName[driver.name] = {
      driverId: driver.id,
      documents: driverDocs
    };
  });

  // Also add documents from the documents table (uploaded separately) to driverDocumentsByName
  // These documents have driverId set but are not stored on the driver record itself
  allDocuments.forEach((doc) => {
    if (doc.driverId && documentCategories.driver.includes(doc.documentType)) {
      // Find the driver this document belongs to
      const driver = (driversData || []).find((d: any) => d.id === doc.driverId);
      if (driver) {
        // Check if this driver exists in our folder structure
        if (driverDocumentsByName[driver.name]) {
          // Check if this document is not already in the list (avoid duplicates)
          const existingDoc = driverDocumentsByName[driver.name].documents.find(
            (d) => d.id === doc.id || (d.documentType === doc.documentType && d.fileUrl === doc.fileUrl)
          );
          if (!existingDoc) {
            driverDocumentsByName[driver.name].documents.push(doc);
          }
        }
      }
    }
  });

  // For solo carriers: Add driver documents from verification data
  // Solo carriers upload their license/aadhaar during onboarding, not via drivers table
  const carrierName = user?.companyName || user?.username || "Me";
  if (verificationData?.documents && verificationData.documents.length > 0) {
    const verificationDriverDocs: Document[] = [];
    verificationData.documents.forEach((doc) => {
      // Only include driver-related document types (license, aadhaar, etc.)
      if (documentCategories.driver.includes(doc.documentType)) {
        verificationDriverDocs.push({
          id: `verification-${doc.id}`,
          documentType: doc.documentType,
          fileName: doc.fileName || documentTypeLabels[doc.documentType] || doc.documentType,
          fileUrl: doc.fileUrl,
          fileSize: undefined,
          expiryDate: null,
          isVerified: doc.status === "approved",
          verificationStatus: doc.status as "pending" | "approved" | "rejected",
          rejectionReason: doc.rejectionReason,
          createdAt: doc.createdAt || new Date().toISOString(),
        });
      }
    });
    
    // Add verification driver docs to folder structure if there are any
    if (verificationDriverDocs.length > 0) {
      if (!driverDocumentsByName[carrierName]) {
        driverDocumentsByName[carrierName] = {
          driverId: user?.id || "",
          documents: []
        };
      }
      // Add only non-duplicate documents
      verificationDriverDocs.forEach((vDoc) => {
        const existingDoc = driverDocumentsByName[carrierName].documents.find(
          (d) => d.documentType === vDoc.documentType && d.fileUrl === vDoc.fileUrl
        );
        if (!existingDoc) {
          driverDocumentsByName[carrierName].documents.push(vDoc);
        }
      });
    }
  }

  const DriverFolderSection = () => {
    const driverNames = Object.keys(driverDocumentsByName).sort();
    const totalDriverDocs = Object.values(driverDocumentsByName).reduce(
      (sum, d) => sum + d.documents.length, 0
    );

    return (
      <Collapsible 
        open={expandedFolders.driver} 
        onOpenChange={() => toggleFolder("driver")}
      >
        <div className="flex items-center gap-2 p-3 rounded-lg hover-elevate border bg-card">
          <CollapsibleTrigger className="flex items-center gap-2 flex-1">
            {expandedFolders.driver ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            {expandedFolders.driver ? (
              <FolderOpen className="h-5 w-5 text-amber-500" />
            ) : (
              <Folder className="h-5 w-5 text-amber-500" />
            )}
            <User className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">Driver Documents</span>
          </CollapsibleTrigger>
          {totalDriverDocs > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                const allDriverDocs = Object.values(driverDocumentsByName).flatMap(d => d.documents);
                openViewAllDialog("Driver Documents", allDriverDocs);
              }}
              data-testid="button-view-all-driver-docs"
            >
              <Eye className="h-4 w-4 mr-1" />
              View All
            </Button>
          )}
          <Badge variant="secondary" className="text-xs">
            {totalDriverDocs}
          </Badge>
        </div>
        <CollapsibleContent>
          <div className="ml-6 mt-2 space-y-2 border-l-2 border-muted pl-4">
            {driverNames.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No driver documents uploaded</p>
            ) : (
              driverNames.map(driverName => {
                const driverData = driverDocumentsByName[driverName];
                const isExpanded = expandedDrivers[`driver-${driverData.driverId}`];
                return (
                  <Collapsible 
                    key={driverData.driverId}
                    open={isExpanded}
                    onOpenChange={() => toggleDriver(`driver-${driverData.driverId}`)}
                  >
                    <CollapsibleTrigger className="w-full">
                      <div className="flex items-center gap-2 p-2 rounded-lg hover-elevate border bg-muted/50">
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        )}
                        {isExpanded ? (
                          <FolderOpen className="h-4 w-4 text-primary" />
                        ) : (
                          <Folder className="h-4 w-4 text-primary" />
                        )}
                        <User className="h-3 w-3 text-muted-foreground" />
                        <span className="font-medium text-sm">{driverName}</span>
                        <Badge variant="secondary" className="ml-auto text-xs">
                          {driverData.documents.length} {driverData.documents.length === 1 ? 'doc' : 'docs'}
                        </Badge>
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="ml-6 mt-2 space-y-2 border-l border-muted pl-3">
                        {driverData.documents.length === 0 ? (
                          <p className="text-sm text-muted-foreground py-2 italic">No documents uploaded yet</p>
                        ) : (
                          driverData.documents.map(doc => (
                            <div
                              key={doc.id}
                              className="flex items-center gap-3 p-3 rounded-lg border bg-card hover-elevate cursor-pointer"
                              onClick={() => {
                                setSelectedDocument(doc as Document);
                                setPreviewDialogOpen(true);
                              }}
                              data-testid={`doc-item-${doc.id}`}
                            >
                              <div className="flex-shrink-0">
                                <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                                  <FileText className="h-5 w-5 text-muted-foreground" />
                                </div>
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <CheckCircle className="h-4 w-4 text-green-500" />
                                  <p className="font-medium truncate">{documentTypeLabels[doc.documentType] || doc.documentType}</p>
                                </div>
                                <p className="text-sm text-muted-foreground truncate">
                                  {driverName} - {documentTypeLabels[doc.documentType] || doc.documentType}
                                </p>
                              </div>
                              <div className="flex items-center gap-2">
                                <Badge variant="default" className="text-xs">
                                  Verified
                                </Badge>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (doc.fileUrl) {
                                      window.open(doc.fileUrl, '_blank');
                                    }
                                  }}
                                  data-testid={`button-download-${doc.id}`}
                                >
                                  <Download className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  const TruckFolderSection = () => {
    const truckPlates = Object.keys(truckDocumentsByPlate).sort();
    const totalTruckDocs = Object.values(truckDocumentsByPlate).reduce(
      (sum, t) => sum + t.documents.length, 0
    );

    return (
      <Collapsible 
        open={expandedFolders.truck} 
        onOpenChange={() => toggleFolder("truck")}
      >
        <div className="flex items-center gap-2 p-3 rounded-lg hover-elevate border bg-card">
          <CollapsibleTrigger className="flex items-center gap-2 flex-1">
            {expandedFolders.truck ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            {expandedFolders.truck ? (
              <FolderOpen className="h-5 w-5 text-amber-500" />
            ) : (
              <Folder className="h-5 w-5 text-amber-500" />
            )}
            <Truck className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">Truck Documents</span>
          </CollapsibleTrigger>
          {totalTruckDocs > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                const allTruckDocs = Object.values(truckDocumentsByPlate).flatMap(t => t.documents);
                openViewAllDialog("Truck Documents", allTruckDocs);
              }}
              data-testid="button-view-all-truck-docs"
            >
              <Eye className="h-4 w-4 mr-1" />
              View All
            </Button>
          )}
          <Badge variant="secondary" className="text-xs">
            {totalTruckDocs}
          </Badge>
        </div>
        <CollapsibleContent>
          <div className="ml-6 mt-2 space-y-2 border-l-2 border-muted pl-4">
            {truckPlates.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No trucks added yet</p>
            ) : (
              truckPlates.map(plate => {
                const truckData = truckDocumentsByPlate[plate];
                const isExpanded = expandedTrucks[`truck-${truckData.truckId}`];
                return (
                  <Collapsible 
                    key={truckData.truckId}
                    open={isExpanded}
                    onOpenChange={() => toggleTruck(`truck-${truckData.truckId}`)}
                  >
                    <CollapsibleTrigger className="w-full">
                      <div className="flex items-center gap-2 p-2 rounded-lg hover-elevate border bg-muted/50">
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        )}
                        {isExpanded ? (
                          <FolderOpen className="h-4 w-4 text-primary" />
                        ) : (
                          <Folder className="h-4 w-4 text-primary" />
                        )}
                        <Truck className="h-3 w-3 text-muted-foreground" />
                        <span className="font-medium text-sm">{plate}</span>
                        <Badge variant="secondary" className="ml-auto text-xs">
                          {truckData.documents.length} {truckData.documents.length === 1 ? 'doc' : 'docs'}
                        </Badge>
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="ml-6 mt-2 space-y-2 border-l border-muted pl-3">
                        {truckData.documents.length === 0 ? (
                          <p className="text-sm text-muted-foreground py-2 italic">No documents uploaded yet</p>
                        ) : (
                          truckData.documents.map(doc => (
                            <div
                              key={doc.id}
                              className="flex items-center gap-3 p-3 rounded-lg border bg-card hover-elevate cursor-pointer"
                              onClick={() => {
                                setSelectedDocument(doc as Document);
                                setPreviewDialogOpen(true);
                              }}
                              data-testid={`doc-item-${doc.id}`}
                            >
                              <div className="flex-shrink-0">
                                <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                                  <FileText className="h-5 w-5 text-muted-foreground" />
                                </div>
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <CheckCircle className="h-4 w-4 text-green-500" />
                                  <p className="font-medium truncate">{documentTypeLabels[doc.documentType] || doc.documentType}</p>
                                </div>
                                <p className="text-sm text-muted-foreground truncate">
                                  {plate} - {documentTypeLabels[doc.documentType] || doc.documentType}
                                </p>
                              </div>
                              <div className="flex items-center gap-2">
                                <Badge variant="default" className="text-xs">
                                  Verified
                                </Badge>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (doc.fileUrl) {
                                      window.open(doc.fileUrl, '_blank');
                                    }
                                  }}
                                  data-testid={`button-download-${doc.id}`}
                                >
                                  <Download className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  const renderDocumentList = (docs: Document[], emptyMessage: string) => (
    docs.length === 0 ? (
      <div className="text-center py-8 text-muted-foreground">
        <FileText className="h-12 w-12 mx-auto mb-2 opacity-50" />
        <p>{emptyMessage}</p>
        <Button 
          variant="outline" 
          className="mt-4"
          onClick={() => setUploadDialogOpen(true)}
          data-testid="button-upload-empty-state"
        >
          <Upload className="h-4 w-4 mr-2" />
          Upload Document
        </Button>
      </div>
    ) : (
      <div className="space-y-3">
        {docs.map(doc => renderDocument(doc))}
      </div>
    )
  );

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold" data-testid="text-page-title">My Documents</h1>
        <Button onClick={() => setUploadDialogOpen(true)} data-testid="button-upload-document">
          <Upload className="h-4 w-4 mr-2" />
          Upload Document
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900">
                <FileText className="h-5 w-5 text-blue-600 dark:text-blue-300" />
              </div>
              <div>
                <p className="text-2xl font-bold" data-testid="text-total-docs">{summary.totalDocs + driverDocumentsFromDrivers.length + truckDocumentsFromTrucks.length}</p>
                <p className="text-sm text-muted-foreground">Total Documents</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className={summary.expiredCount > 0 ? "border-red-200 bg-red-50 dark:bg-red-950/20" : ""}>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-red-100 dark:bg-red-900">
                <XCircle className="h-5 w-5 text-red-600 dark:text-red-300" />
              </div>
              <div>
                <p className="text-2xl font-bold" data-testid="text-expired-count">{summary.expiredCount}</p>
                <p className="text-sm text-muted-foreground">Expired</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className={summary.expiringSoonCount > 0 ? "border-amber-200 bg-amber-50 dark:bg-amber-950/20" : ""}>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-900">
                <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-300" />
              </div>
              <div>
                <p className="text-2xl font-bold" data-testid="text-expiring-soon-count">{summary.expiringSoonCount}</p>
                <p className="text-sm text-muted-foreground">Expiring Soon</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-100 dark:bg-green-900">
                <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-300" />
              </div>
              <div>
                <p className="text-2xl font-bold" data-testid="text-healthy-count">{summary.healthyCount + driverDocumentsFromDrivers.length + truckDocumentsFromTrucks.length}</p>
                <p className="text-sm text-muted-foreground">Valid</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {(summary.expiredCount > 0 || summary.expiringSoonCount > 0) && (
        <Alert variant={summary.expiredCount > 0 ? "destructive" : "default"} className={summary.expiredCount === 0 ? "border-amber-500 bg-amber-50 dark:bg-amber-950" : ""}>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {summary.expiredCount > 0 ? "Action Required: Documents Expired" : "Reminder: Documents Expiring Soon"}
          </AlertTitle>
          <AlertDescription className="space-y-3">
            {expired.length > 0 && (
              <div>
                <p className="font-medium text-red-600 dark:text-red-400">Expired:</p>
                <ul className="list-disc list-inside text-sm mt-1">
                  {expired.map(doc => (
                    <li key={doc.id}>
                      <button
                        type="button"
                        className="text-left underline hover:text-red-800 dark:hover:text-red-300 cursor-pointer"
                        onClick={() => {
                          setSelectedDocument(doc);
                          setPreviewDialogOpen(true);
                        }}
                        data-testid={`link-expired-doc-${doc.id}`}
                      >
                        {documentTypeLabels[doc.documentType] || doc.documentType}
                        {getDocumentOwnerInfo(doc) && ` ${getDocumentOwnerInfo(doc)}`}
                      </button>
                      {doc.expiryDate && ` - expired ${new Date(doc.expiryDate).toLocaleDateString()}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {expiringSoon.length > 0 && (
              <div>
                <p className="font-medium text-amber-600 dark:text-amber-400">Expiring Soon:</p>
                <ul className="list-disc list-inside text-sm mt-1">
                  {expiringSoon.map(doc => (
                    <li key={doc.id}>
                      <button
                        type="button"
                        className="text-left underline hover:text-amber-800 dark:hover:text-amber-300 cursor-pointer"
                        onClick={() => {
                          setSelectedDocument(doc);
                          setPreviewDialogOpen(true);
                        }}
                        data-testid={`link-expiring-doc-${doc.id}`}
                      >
                        {documentTypeLabels[doc.documentType] || doc.documentType}
                        {getDocumentOwnerInfo(doc) && ` ${getDocumentOwnerInfo(doc)}`}
                      </button>
                      {doc.expiryDate && ` - expires ${new Date(doc.expiryDate).toLocaleDateString()}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              Please upload updated versions to maintain compliance and continue bidding on loads.
            </p>
            <Button 
              variant={summary.expiredCount > 0 ? "secondary" : "outline"}
              size="sm"
              className="mt-2"
              onClick={() => setUploadDialogOpen(true)}
              data-testid="button-upload-from-alert"
            >
              <Upload className="h-4 w-4 mr-2" />
              Upload Updated Documents
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="folders" className="w-full">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="folders" data-testid="tab-folders">Folders</TabsTrigger>
          <TabsTrigger value="truck" data-testid="tab-truck">Truck ({truckDocs.length})</TabsTrigger>
          <TabsTrigger value="driver" data-testid="tab-driver">Driver ({driverDocs.length})</TabsTrigger>
          <TabsTrigger value="loads" data-testid="tab-loads">Loads ({Object.values(shipmentsByLoad).reduce((sum, s) => sum + s.documents.length, 0)})</TabsTrigger>
          <TabsTrigger value="alerts" data-testid="tab-alerts">
            Alerts ({expired.length + expiringSoon.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="folders" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Document Folders</CardTitle>
              <CardDescription>Organize your documents by category</CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[calc(100vh-450px)]">
                <div className="space-y-3 pr-4">
                  <TruckFolderSection />
                  <DriverFolderSection />
                  <LoadsFolderSection />
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="truck" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Truck Documents</CardTitle>
              <CardDescription>RC, Insurance, Fitness, PUC, and Permits</CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[calc(100vh-450px)]">
                <div className="pr-4">
                  {renderDocumentList(truckDocs, "No truck documents uploaded")}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="driver" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Driver Documents</CardTitle>
              <CardDescription>License, PAN Card, and Aadhar</CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[calc(100vh-450px)]">
                <div className="pr-4">
                  {renderDocumentList(driverDocs, "No driver documents uploaded")}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="loads" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Load Documents</CardTitle>
              <CardDescription>Invoice, POD, E-Way Bill, and other shipment documents</CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[calc(100vh-450px)]">
                <div className="pr-4">
                  {(() => {
                    const loadNumbers = Object.keys(shipmentsByLoad).map(Number).sort((a, b) => b - a);
                    if (loadNumbers.length === 0) {
                      return (
                        <div className="text-center py-8">
                          <Package className="h-12 w-12 mx-auto mb-2 text-muted-foreground opacity-50" />
                          <p className="font-medium">No load documents yet</p>
                          <p className="text-sm text-muted-foreground">Documents will appear here once you upload them for your shipments</p>
                        </div>
                      );
                    }
                    return (
                      <div className="space-y-4">
                        {loadNumbers.map(loadNum => {
                          const shipment = shipmentsByLoad[loadNum];
                          return (
                            <div key={loadNum} className="space-y-2" data-testid={`load-docs-${loadNum}`}>
                              <div className="flex items-center gap-2">
                                <Package className="h-4 w-4 text-primary" />
                                <span className="font-medium text-sm">LD-{String(loadNum).padStart(3, '0')}</span>
                                <Badge variant="outline" className="text-xs capitalize">
                                  {shipment.status.replace(/_/g, ' ')}
                                </Badge>
                                <Badge variant="secondary" className="text-xs">
                                  {shipment.documents.length} {shipment.documents.length === 1 ? 'doc' : 'docs'}
                                </Badge>
                              </div>
                              {shipment.documents.length > 0 ? (
                                <div className="ml-6 space-y-2">
                                  {shipment.documents.map(doc => renderShipmentDocument(doc))}
                                </div>
                              ) : (
                                <p className="ml-6 text-sm text-muted-foreground">No documents uploaded for this load</p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="alerts" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-amber-600">
                <AlertTriangle className="h-5 w-5" />
                Documents Requiring Attention
              </CardTitle>
              <CardDescription>Expired or expiring documents</CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[calc(100vh-450px)]">
                <div className="pr-4">
                  {expired.length === 0 && expiringSoon.length === 0 ? (
                    <div className="text-center py-8">
                      <CheckCircle className="h-12 w-12 mx-auto mb-2 text-green-500" />
                      <p className="font-medium">All documents are valid!</p>
                      <p className="text-sm text-muted-foreground">No documents require attention at this time</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {[...expired, ...expiringSoon].map(doc => renderDocument(doc))}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload Document</DialogTitle>
            <DialogDescription>
              Upload your compliance documents. Supported formats: PDF, JPG, PNG
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Document Type</Label>
              <Select value={selectedDocType} onValueChange={(val) => {
                setSelectedDocType(val);
                setSelectedDriverId("");
                setSelectedTruckId("");
              }}>
                <SelectTrigger data-testid="select-document-type">
                  <SelectValue placeholder="Select document type..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="license">Driving License</SelectItem>
                  <SelectItem value="rc">Registration Certificate (RC)</SelectItem>
                  <SelectItem value="insurance">Vehicle Insurance</SelectItem>
                  <SelectItem value="fitness">Fitness Certificate</SelectItem>
                  <SelectItem value="permit">Road Permit</SelectItem>
                  <SelectItem value="puc">PUC Certificate</SelectItem>
                  <SelectItem value="pan_card">PAN Card</SelectItem>
                  <SelectItem value="aadhar">Aadhar Card</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Driver selection for fleet/enterprise carriers when uploading driver docs */}
            {carrierType === "enterprise" && 
              isDriverDocType(selectedDocType) && 
              driversData && driversData.length > 0 && (
              <div className="space-y-2">
                <Label>Select Driver</Label>
                <Select value={selectedDriverId} onValueChange={setSelectedDriverId}>
                  <SelectTrigger data-testid="select-driver">
                    <SelectValue placeholder="Select which driver..." />
                  </SelectTrigger>
                  <SelectContent>
                    {driversData.map((driver: any) => (
                      <SelectItem key={driver.id} value={driver.id}>
                        <div className="flex items-center gap-2">
                          <User className="h-3 w-3 text-muted-foreground" />
                          <span>{driver.name}</span>
                          {driver.phone && (
                            <span className="text-muted-foreground text-xs">({driver.phone})</span>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Select the driver this document belongs to
                </p>
              </div>
            )}

            {/* Truck selection for fleet/enterprise carriers when uploading truck docs */}
            {carrierType === "enterprise" && 
              isTruckDocType(selectedDocType) && 
              trucksData && trucksData.length > 0 && (
              <div className="space-y-2">
                <Label>Select Truck</Label>
                <Select value={selectedTruckId} onValueChange={setSelectedTruckId}>
                  <SelectTrigger data-testid="select-truck">
                    <SelectValue placeholder="Select which truck..." />
                  </SelectTrigger>
                  <SelectContent>
                    {trucksData.map((truck: any) => (
                      <SelectItem key={truck.id} value={truck.id}>
                        <div className="flex items-center gap-2">
                          <Truck className="h-3 w-3 text-muted-foreground" />
                          <span>{truck.licensePlate || truck.registrationNumber || `Truck ${truck.id}`}</span>
                          {truck.truckType && (
                            <span className="text-muted-foreground text-xs">({truck.truckType})</span>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Select the truck this document belongs to
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label>File</Label>
              <div className="border-2 border-dashed border-border rounded-lg p-6 text-center">
                {selectedFile ? (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <File className="h-4 w-4" />
                      <span className="text-sm">{selectedFile.name}</span>
                      <span className="text-xs text-muted-foreground">({formatFileSize(selectedFile.size)})</span>
                    </div>
                    <Button 
                      size="icon" 
                      variant="ghost" 
                      onClick={() => setSelectedFile(null)}
                      data-testid="button-remove-file"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <label className="cursor-pointer">
                    <div className="flex flex-col items-center gap-2">
                      <Upload className="h-8 w-8 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        Click to browse or drag and drop
                      </p>
                      <p className="text-xs text-muted-foreground">
                        PDF, JPG, or PNG up to 10MB
                      </p>
                    </div>
                    <input 
                      type="file" 
                      className="hidden" 
                      accept=".pdf,.jpg,.jpeg,.png"
                      onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                      data-testid="input-file-upload"
                    />
                  </label>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Expiry Date (Optional)</Label>
              <Input 
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                data-testid="input-expiry-date"
              />
              <p className="text-xs text-muted-foreground">
                Set an expiry date to receive alerts before renewal is needed
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => {
                setUploadDialogOpen(false);
                resetUploadForm();
              }}
              data-testid="button-cancel-upload"
            >
              Cancel
            </Button>
            <Button 
              onClick={handleUpload}
              disabled={!selectedDocType || !selectedFile || uploadMutation.isPending}
              data-testid="button-confirm-upload"
            >
              {uploadMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={previewDialogOpen} onOpenChange={setPreviewDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          {selectedDocument && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                    <FileText className="h-5 w-5" />
                  </div>
                  <div>
                    <DialogTitle>
                      {documentTypeLabels[selectedDocument.documentType] || selectedDocument.documentType}
                    </DialogTitle>
                    <DialogDescription>
                      {selectedDocument.fileName}
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>

              <div className="py-4">
                <DocumentPreview 
                  fileUrl={selectedDocument.fileUrl}
                  fileName={selectedDocument.fileName}
                />

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">File Size</p>
                    <p className="font-medium">{formatFileSize(selectedDocument.fileSize)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Status</p>
                    <div className="mt-1">
                      {selectedDocument.verificationStatus === "rejected" ? (
                        <Badge variant="destructive">Rejected</Badge>
                      ) : selectedDocument.isVerified || selectedDocument.verificationStatus === "approved" ? (
                        <Badge variant="default">Verified</Badge>
                      ) : (
                        <Badge variant="secondary">Pending Review</Badge>
                      )}
                    </div>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Uploaded</p>
                    <p className="font-medium">
                      {selectedDocument.createdAt ? format(new Date(selectedDocument.createdAt), "dd MMM yyyy") : "N/A"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Expiry Date</p>
                    <p className="font-medium">
                      {selectedDocument.expiryDate 
                        ? format(new Date(selectedDocument.expiryDate), "dd MMM yyyy")
                        : "No expiry date"}
                    </p>
                  </div>
                </div>

                {selectedDocument.verificationStatus === "rejected" && selectedDocument.rejectionReason && (
                  <div className="mt-4 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg">
                    <p className="text-sm font-medium text-red-800 dark:text-red-400">Rejection Reason:</p>
                    <p className="text-sm text-red-700 dark:text-red-300 mt-1">{selectedDocument.rejectionReason}</p>
                  </div>
                )}
              </div>

              <DialogFooter className="flex-col sm:flex-row gap-2">
                <Button 
                  variant="outline"
                  onClick={() => window.open(selectedDocument.fileUrl, "_blank")}
                  data-testid="button-view-full"
                >
                  <Eye className="h-4 w-4 mr-2" />
                  View Full Size
                </Button>
                <Button 
                  variant="outline"
                  onClick={() => window.open(selectedDocument.fileUrl, "_blank")}
                  data-testid="button-download-preview"
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download
                </Button>
                <Button 
                  variant="destructive"
                  onClick={() => handleDelete(selectedDocument.id)}
                  disabled={deleteMutation.isPending}
                  data-testid="button-delete-document"
                >
                  {deleteMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4 mr-2" />
                  )}
                  Delete
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={viewAllDialogOpen} onOpenChange={setViewAllDialogOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderOpen className="h-5 w-5 text-amber-500" />
              {viewAllFolderName}
            </DialogTitle>
            <DialogDescription>
              {viewAllDocuments.length} document{viewAllDocuments.length !== 1 ? 's' : ''} in this folder
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="h-[50vh] pr-4">
            <div className="space-y-3">
              {viewAllDocuments.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">No documents in this folder</p>
              ) : (
                viewAllDocuments.map(doc => (
                  <div
                    key={doc.id}
                    className="flex items-center gap-3 p-3 rounded-lg border bg-card hover-elevate cursor-pointer"
                    onClick={() => {
                      setSelectedDocument(doc);
                      setViewAllDialogOpen(false);
                      setPreviewDialogOpen(true);
                    }}
                    data-testid={`view-all-doc-${doc.id}`}
                  >
                    <div className="flex-shrink-0">
                      <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                        <FileText className="h-5 w-5 text-muted-foreground" />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {doc.verificationStatus === "approved" || doc.isVerified ? (
                          <CheckCircle className="h-4 w-4 text-green-500" />
                        ) : doc.verificationStatus === "rejected" ? (
                          <XCircle className="h-4 w-4 text-red-500" />
                        ) : (
                          <Clock className="h-4 w-4 text-amber-500" />
                        )}
                        <p className="font-medium truncate">
                          {documentTypeLabels[doc.documentType] || doc.documentType}
                        </p>
                      </div>
                      <p className="text-sm text-muted-foreground truncate">
                        {getDocumentOwnerInfo(doc) || doc.fileName}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {doc.expiryDate && (
                        <span className={`text-xs ${
                          new Date(doc.expiryDate) < new Date() 
                            ? 'text-red-500' 
                            : differenceInDays(new Date(doc.expiryDate), new Date()) <= 30 
                              ? 'text-amber-500'
                              : 'text-muted-foreground'
                        }`}>
                          {new Date(doc.expiryDate) < new Date() 
                            ? 'Expired' 
                            : `Expires ${format(new Date(doc.expiryDate), 'MMM d, yyyy')}`
                          }
                        </span>
                      )}
                      <Badge 
                        variant={doc.verificationStatus === "approved" || doc.isVerified ? "default" : doc.verificationStatus === "rejected" ? "destructive" : "secondary"}
                        className="text-xs"
                      >
                        {doc.verificationStatus === "approved" || doc.isVerified ? 'Verified' : doc.verificationStatus === "rejected" ? 'Rejected' : 'Pending'}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (doc.fileUrl) {
                            window.open(doc.fileUrl, '_blank');
                          }
                        }}
                        data-testid={`button-download-viewall-${doc.id}`}
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewAllDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
