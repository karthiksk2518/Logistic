import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Truck, User, FileText, CreditCard, Upload, Check, Clock, 
  AlertCircle, Loader2, Building2, Shield, IdCard
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { DocumentUploadWithCamera } from "@/components/DocumentUploadWithCamera";
import { useAuth } from "@/lib/auth-context";

const soloFormSchema = z.object({
  carrierType: z.literal("solo"),
  aadhaarNumber: z.string().min(12, "Aadhaar must be 12 digits").max(12),
  driverLicenseNumber: z.string().min(1, "License number is required"),
  panNumber: z.string().min(10, "PAN must be 10 characters").max(10),
  permitType: z.enum(["national", "domestic"]),
  uniqueRegistrationNumber: z.string().optional(),
  chassisNumber: z.string().min(1, "Chassis number is required"),
  licensePlateNumber: z.string().min(1, "License plate is required"),
  businessAddress: z.string().min(1, "Business address is required"),
  businessLocality: z.string().min(1, "Locality is required"),
  aadhaarUrl: z.string().optional(),
  licenseUrl: z.string().optional(),
  panUrl: z.string().optional(),
  permitUrl: z.string().optional(),
  rcUrl: z.string().optional(),
  insuranceUrl: z.string().optional(),
  fitnessUrl: z.string().optional(),
  tdsDeclarationUrl: z.string().optional(),
  selfieUrl: z.string().optional(),
  msmeUdyamUrl: z.string().optional(),
  // Bank details
  bankName: z.string().optional(),
  bankAccountNumber: z.string().optional(),
  bankIfscCode: z.string().optional(),
  bankAccountHolderName: z.string().optional(),
  voidChequeUrl: z.string().optional(),
});

const fleetFormSchema = z.object({
  carrierType: z.literal("enterprise"),
  // Identity tab fields
  aadhaarNumber: z.string().min(12, "Aadhaar must be 12 digits").max(12),
  driverLicenseNumber: z.string().optional(),
  panNumber: z.string().optional(),
  gstinNumber: z.string().optional(),
  noGstinNumber: z.boolean().optional(),
  businessType: z.enum(["sole_proprietor", "registered_partnership", "non_registered_partnership", "other"]).optional(),
  cinNumber: z.string().optional(),
  partnerName: z.string().optional(),
  businessAddress: z.string().min(1, "Business address is required"),
  businessLocality: z.string().min(1, "Locality is required"),
  fleetSize: z.coerce.number().int().min(1),
  // Vehicle tab fields (for one truck)
  licensePlateNumber: z.string().min(1, "License plate is required"),
  chassisNumber: z.string().min(1, "Chassis number is required"),
  uniqueRegistrationNumber: z.string().optional(),
  permitType: z.enum(["national", "domestic"]),
  // Document URLs
  aadhaarUrl: z.string().optional(),
  licenseUrl: z.string().optional(),
  panUrl: z.string().optional(),
  gstinUrl: z.string().optional(),
  cinUrl: z.string().optional(),
  addressProofType: z.enum(["rent_agreement", "electricity_bill", "office_photo_with_board"]).optional(),
  addressProofUrl: z.string().optional(),
  selfieUrl: z.string().optional(),
  rcUrl: z.string().optional(),
  insuranceUrl: z.string().optional(),
  fitnessUrl: z.string().optional(),
  tdsDeclarationUrl: z.string().optional(),
  msmeUdyamUrl: z.string().optional(),
  // Bank details
  bankName: z.string().optional(),
  bankAccountNumber: z.string().optional(),
  bankIfscCode: z.string().optional(),
  bankAccountHolderName: z.string().optional(),
  voidChequeUrl: z.string().optional(),
});

const formSchema = z.discriminatedUnion("carrierType", [soloFormSchema, fleetFormSchema]);

type FormData = z.infer<typeof formSchema>;

interface OnboardingResponse {
  id: string;
  carrierId: string;
  status: string;
  carrierType: string;
  fleetSize: number;
  aadhaarNumber?: string;
  driverLicenseNumber?: string;
  permitType?: string;
  uniqueRegistrationNumber?: string;
  chassisNumber?: string;
  licensePlateNumber?: string;
  incorporationType?: string;
  businessType?: string;
  cinNumber?: string;
  partnerName?: string;
  businessRegistrationNumber?: string;
  businessAddress?: string;
  businessLocality?: string;
  panNumber?: string;
  gstinNumber?: string;
  tanNumber?: string;
  // Bank details
  bankName?: string;
  bankAccountNumber?: string;
  bankIfscCode?: string;
  bankAccountHolderName?: string;
  rejectionReason?: string;
  notes?: string;
  documents: Array<{
    id: string;
    documentType: string;
    fileName: string;
    fileUrl: string;
  }>;
}

export default function CarrierOnboarding() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState("identity");
  const [carrierType, setCarrierType] = useState<"solo" | "enterprise">("solo");
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedDataRef = useRef<string>("");
  const formInitializedRef = useRef<boolean>(false);

  const { data: onboardingStatus, isLoading: isLoadingStatus } = useQuery<OnboardingResponse>({
    queryKey: ["/api/carrier/onboarding"],
  });

  const soloForm = useForm<z.infer<typeof soloFormSchema>>({
    resolver: zodResolver(soloFormSchema),
    defaultValues: {
      carrierType: "solo",
      aadhaarNumber: "",
      driverLicenseNumber: "",
      panNumber: "",
      permitType: "national",
      uniqueRegistrationNumber: "",
      chassisNumber: "",
      licensePlateNumber: "",
      businessAddress: "",
      businessLocality: "",
      aadhaarUrl: "",
      licenseUrl: "",
      panUrl: "",
      permitUrl: "",
      rcUrl: "",
      insuranceUrl: "",
      fitnessUrl: "",
      selfieUrl: "",
      msmeUdyamUrl: "",
      bankName: "",
      bankAccountNumber: "",
      bankIfscCode: "",
      bankAccountHolderName: "",
      voidChequeUrl: "",
    },
  });

  const fleetForm = useForm<z.infer<typeof fleetFormSchema>>({
    resolver: zodResolver(fleetFormSchema),
    defaultValues: {
      carrierType: "enterprise",
      aadhaarNumber: "",
      driverLicenseNumber: "",
      panNumber: "",
      gstinNumber: "",
      noGstinNumber: false,
      businessType: undefined,
      cinNumber: "",
      partnerName: "",
      businessAddress: "",
      businessLocality: "",
      fleetSize: 1,
      licensePlateNumber: "",
      chassisNumber: "",
      uniqueRegistrationNumber: "",
      permitType: "national",
      aadhaarUrl: "",
      licenseUrl: "",
      panUrl: "",
      gstinUrl: "",
      cinUrl: "",
      addressProofType: undefined,
      addressProofUrl: "",
      selfieUrl: "",
      rcUrl: "",
      insuranceUrl: "",
      fitnessUrl: "",
      msmeUdyamUrl: "",
      bankName: "",
      bankAccountNumber: "",
      bankIfscCode: "",
      bankAccountHolderName: "",
      voidChequeUrl: "",
    },
  });

  useEffect(() => {
    if (onboardingStatus) {
      const type = onboardingStatus.carrierType === "enterprise" ? "enterprise" : "solo";
      setCarrierType(type);
      
      if (formInitializedRef.current) {
        if (type === "solo") {
          const docFields: Partial<Record<string, string>> = {
            aadhaarUrl: onboardingStatus.documents.find(d => d.documentType === "aadhaar")?.fileUrl || "",
            licenseUrl: onboardingStatus.documents.find(d => d.documentType === "license")?.fileUrl || "",
            panUrl: onboardingStatus.documents.find(d => d.documentType === "pan")?.fileUrl || "",
            permitUrl: onboardingStatus.documents.find(d => d.documentType === "permit")?.fileUrl || "",
            rcUrl: onboardingStatus.documents.find(d => d.documentType === "rc")?.fileUrl || "",
            insuranceUrl: onboardingStatus.documents.find(d => d.documentType === "insurance")?.fileUrl || "",
            fitnessUrl: onboardingStatus.documents.find(d => d.documentType === "fitness")?.fileUrl || "",
            tdsDeclarationUrl: onboardingStatus.documents.find(d => d.documentType === "tds_declaration")?.fileUrl || "",
            selfieUrl: onboardingStatus.documents.find(d => d.documentType === "selfie")?.fileUrl || "",
            msmeUdyamUrl: onboardingStatus.documents.find(d => d.documentType === "msme_udyam" || d.documentType === "msme" || d.documentType === "udyam")?.fileUrl || "",
            voidChequeUrl: onboardingStatus.documents.find(d => d.documentType === "void_cheque")?.fileUrl || "",
          };
          for (const [key, val] of Object.entries(docFields)) {
            if (val) soloForm.setValue(key as any, val);
          }
        } else {
          const docFields: Partial<Record<string, string>> = {
            aadhaarUrl: onboardingStatus.documents.find(d => d.documentType === "aadhaar")?.fileUrl || "",
            licenseUrl: onboardingStatus.documents.find(d => d.documentType === "license")?.fileUrl || "",
            panUrl: onboardingStatus.documents.find(d => d.documentType === "pan")?.fileUrl || "",
            gstinUrl: onboardingStatus.documents.find(d => d.documentType === "gstin")?.fileUrl || "",
            cinUrl: onboardingStatus.documents.find(d => d.documentType === "cin")?.fileUrl || "",
            addressProofUrl: onboardingStatus.documents.find(d => d.documentType === "address_proof")?.fileUrl || "",
            selfieUrl: onboardingStatus.documents.find(d => d.documentType === "selfie")?.fileUrl || "",
            rcUrl: onboardingStatus.documents.find(d => d.documentType === "rc")?.fileUrl || "",
            insuranceUrl: onboardingStatus.documents.find(d => d.documentType === "insurance")?.fileUrl || "",
            fitnessUrl: onboardingStatus.documents.find(d => d.documentType === "fitness")?.fileUrl || "",
            tdsDeclarationUrl: onboardingStatus.documents.find(d => d.documentType === "tds_declaration")?.fileUrl || "",
            msmeUdyamUrl: onboardingStatus.documents.find(d => d.documentType === "msme_udyam" || d.documentType === "msme" || d.documentType === "udyam")?.fileUrl || "",
            voidChequeUrl: onboardingStatus.documents.find(d => d.documentType === "void_cheque")?.fileUrl || "",
          };
          for (const [key, val] of Object.entries(docFields)) {
            if (val) fleetForm.setValue(key as any, val);
          }
        }
        return;
      }
      
      formInitializedRef.current = true;

      if (type === "solo") {
        const formData = {
          carrierType: "solo" as const,
          aadhaarNumber: onboardingStatus.aadhaarNumber || "",
          driverLicenseNumber: onboardingStatus.driverLicenseNumber || "",
          panNumber: onboardingStatus.panNumber || "",
          permitType: (onboardingStatus.permitType as "national" | "domestic") || "national",
          uniqueRegistrationNumber: onboardingStatus.uniqueRegistrationNumber || "",
          chassisNumber: onboardingStatus.chassisNumber || "",
          licensePlateNumber: onboardingStatus.licensePlateNumber || "",
          businessAddress: onboardingStatus.businessAddress || "",
          businessLocality: onboardingStatus.businessLocality || "",
          aadhaarUrl: onboardingStatus.documents.find(d => d.documentType === "aadhaar")?.fileUrl || "",
          licenseUrl: onboardingStatus.documents.find(d => d.documentType === "license")?.fileUrl || "",
          panUrl: onboardingStatus.documents.find(d => d.documentType === "pan")?.fileUrl || "",
          permitUrl: onboardingStatus.documents.find(d => d.documentType === "permit")?.fileUrl || "",
          rcUrl: onboardingStatus.documents.find(d => d.documentType === "rc")?.fileUrl || "",
          insuranceUrl: onboardingStatus.documents.find(d => d.documentType === "insurance")?.fileUrl || "",
          fitnessUrl: onboardingStatus.documents.find(d => d.documentType === "fitness")?.fileUrl || "",
          tdsDeclarationUrl: onboardingStatus.documents.find(d => d.documentType === "tds_declaration")?.fileUrl || "",
          selfieUrl: onboardingStatus.documents.find(d => d.documentType === "selfie")?.fileUrl || "",
          msmeUdyamUrl: onboardingStatus.documents.find(d => d.documentType === "msme_udyam" || d.documentType === "msme" || d.documentType === "udyam")?.fileUrl || "",
          bankName: onboardingStatus.bankName || "",
          bankAccountNumber: onboardingStatus.bankAccountNumber || "",
          bankIfscCode: onboardingStatus.bankIfscCode || "",
          bankAccountHolderName: onboardingStatus.bankAccountHolderName || "",
          voidChequeUrl: onboardingStatus.documents.find(d => d.documentType === "void_cheque")?.fileUrl || "",
        };
        soloForm.reset(formData);
        lastSavedDataRef.current = JSON.stringify(formData);
      } else {
        const formData = {
          carrierType: "enterprise" as const,
          aadhaarNumber: onboardingStatus.aadhaarNumber || "",
          driverLicenseNumber: onboardingStatus.driverLicenseNumber || "",
          panNumber: onboardingStatus.panNumber || "",
          gstinNumber: onboardingStatus.gstinNumber || "",
          noGstinNumber: onboardingStatus.noGstinNumber || false,
          businessType: (onboardingStatus.businessType as "sole_proprietor" | "registered_partnership" | "non_registered_partnership" | "other") || undefined,
          cinNumber: onboardingStatus.cinNumber || "",
          partnerName: onboardingStatus.partnerName || "",
          businessAddress: onboardingStatus.businessAddress || "",
          businessLocality: onboardingStatus.businessLocality || "",
          fleetSize: onboardingStatus.fleetSize || 1,
          licensePlateNumber: onboardingStatus.licensePlateNumber || "",
          chassisNumber: onboardingStatus.chassisNumber || "",
          uniqueRegistrationNumber: onboardingStatus.uniqueRegistrationNumber || "",
          permitType: (onboardingStatus.permitType as "national" | "domestic") || "national",
          aadhaarUrl: onboardingStatus.documents.find(d => d.documentType === "aadhaar")?.fileUrl || "",
          licenseUrl: onboardingStatus.documents.find(d => d.documentType === "license")?.fileUrl || "",
          panUrl: onboardingStatus.documents.find(d => d.documentType === "pan")?.fileUrl || "",
          gstinUrl: onboardingStatus.documents.find(d => d.documentType === "gstin")?.fileUrl || "",
          cinUrl: onboardingStatus.documents.find(d => d.documentType === "cin")?.fileUrl || "",
          addressProofType: (onboardingStatus as any).addressProofType || undefined,
          addressProofUrl: onboardingStatus.documents.find(d => d.documentType === "address_proof")?.fileUrl || "",
          selfieUrl: onboardingStatus.documents.find(d => d.documentType === "selfie")?.fileUrl || "",
          rcUrl: onboardingStatus.documents.find(d => d.documentType === "rc")?.fileUrl || "",
          insuranceUrl: onboardingStatus.documents.find(d => d.documentType === "insurance")?.fileUrl || "",
          fitnessUrl: onboardingStatus.documents.find(d => d.documentType === "fitness")?.fileUrl || "",
          tdsDeclarationUrl: onboardingStatus.documents.find(d => d.documentType === "tds_declaration")?.fileUrl || "",
          msmeUdyamUrl: onboardingStatus.documents.find(d => d.documentType === "msme_udyam" || d.documentType === "msme" || d.documentType === "udyam")?.fileUrl || "",
          bankName: onboardingStatus.bankName || "",
          bankAccountNumber: onboardingStatus.bankAccountNumber || "",
          bankIfscCode: onboardingStatus.bankIfscCode || "",
          bankAccountHolderName: onboardingStatus.bankAccountHolderName || "",
          voidChequeUrl: onboardingStatus.documents.find(d => d.documentType === "void_cheque")?.fileUrl || "",
        };
        fleetForm.reset(formData);
        lastSavedDataRef.current = JSON.stringify(formData);
      }
    }
  }, [onboardingStatus, soloForm, fleetForm]);

  const autoSaveMutation = useMutation({
    mutationFn: async (data: Record<string, any>) => {
      const res = await apiRequest("PATCH", "/api/carrier/onboarding/draft", data);
      return res.json();
    },
    onSuccess: () => {
      setAutoSaveStatus("saved");
      setTimeout(() => setAutoSaveStatus("idle"), 2000);
    },
    onError: () => {
      setAutoSaveStatus("idle");
    },
  });

  const debouncedAutoSave = useCallback((data: Record<string, any>) => {
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }

    const dataString = JSON.stringify(data);
    if (dataString === lastSavedDataRef.current) {
      return;
    }

    setAutoSaveStatus("saving");
    autoSaveTimeoutRef.current = setTimeout(() => {
      lastSavedDataRef.current = dataString;
      autoSaveMutation.mutate(data);
    }, 1500);
  }, [autoSaveMutation]);

  useEffect(() => {
    const editableStatuses = ["draft", "on_hold", "rejected"];
    if (!onboardingStatus?.status || !editableStatuses.includes(onboardingStatus.status)) return;
    
    let unsubscribe: () => void;
    
    if (carrierType === "solo") {
      const sub = soloForm.watch((data) => {
        debouncedAutoSave(data);
      });
      unsubscribe = sub.unsubscribe;
    } else {
      const sub = fleetForm.watch((data) => {
        debouncedAutoSave(data);
      });
      unsubscribe = sub.unsubscribe;
    }

    return () => {
      unsubscribe();
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, [onboardingStatus?.status, carrierType, soloForm, fleetForm, debouncedAutoSave]);

  const uploadDocMutation = useMutation({
    mutationFn: async ({ documentType, fileUrl, fileName }: { documentType: string; fileUrl: string; fileName: string }) => {
      const res = await apiRequest("POST", "/api/carrier/verification/documents", {
        documentType,
        fileName,
        fileUrl,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/carrier/onboarding"] });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: t("common.error"),
        description: error.message,
      });
    },
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/carrier/onboarding/submit", {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/carrier/onboarding"] });
      toast({
        title: t("carrierOnboarding.submitted"),
        description: t("carrierOnboarding.submittedDesc"),
      });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: t("common.error"),
        description: error.message,
      });
    },
  });

  const handleDocumentUpload = (documentType: string, value: string) => {
    if (!value) return;
    
    try {
      const parsed = JSON.parse(value);
      if (parsed.path) {
        uploadDocMutation.mutate({
          documentType,
          fileUrl: parsed.path,
          fileName: parsed.name || "Uploaded Document",
        });
      }
    } catch {
      // Legacy plain URL format
      uploadDocMutation.mutate({
        documentType,
        fileUrl: value,
        fileName: "Uploaded Document",
      });
    }
  };

  const handleSubmit = async () => {
    // Cancel any pending debounced auto-save
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }
    
    // Validate form before submitting
    if (carrierType === "solo") {
      const values = soloForm.getValues();
      const missingFields: string[] = [];
      
      // Check Identity tab fields
      if (!values.aadhaarNumber || values.aadhaarNumber.length < 12) {
        missingFields.push("Aadhaar Number (Identity tab)");
      }
      if (!values.driverLicenseNumber) {
        missingFields.push("Driver License Number (Identity tab)");
      }
      if (!values.panNumber || values.panNumber.length < 10) {
        missingFields.push("PAN Number (Identity tab)");
      }
      if (!values.permitType) {
        missingFields.push("Permit Type (Vehicle tab)");
      }
      
      // Check Vehicle tab fields
      if (!values.licensePlateNumber) {
        missingFields.push("License Plate Number (Vehicle tab)");
      }
      if (!values.chassisNumber) {
        missingFields.push("Chassis Number (Vehicle tab)");
      }
      
      if (missingFields.length > 0) {
        toast({
          variant: "destructive",
          title: t("common.error"),
          description: `Please fill in the following required fields: ${missingFields.join(", ")}`,
        });
        // Navigate to the appropriate tab
        if (missingFields.some(f => f.includes("Identity"))) {
          setActiveTab("identity");
        } else if (missingFields.some(f => f.includes("Vehicle"))) {
          setActiveTab("vehicle");
        }
        return;
      }
      
      // Save form data immediately before submit
      try {
        setAutoSaveStatus("saving");
        await apiRequest("PATCH", "/api/carrier/onboarding/draft", values);
      } catch (error) {
        // Continue with submit even if save fails - server will validate
      }
    } else {
      const values = fleetForm.getValues();
      const missingFields: string[] = [];
      
      if (!values.aadhaarNumber || values.aadhaarNumber.length < 12) {
        missingFields.push("Aadhaar Number (Identity tab)");
      }
      if (!values.businessType) {
        missingFields.push("Business Type (Identity tab)");
      }
      if (values.businessType === "registered_partnership") {
        if (!values.noGstinNumber && !values.gstinNumber) {
          missingFields.push("GSTIN Number (Identity tab)");
        }
      }
      if (values.businessType === "non_registered_partnership") {
        if (!values.driverLicenseNumber) {
          missingFields.push("Partner Driver License Number (Identity tab)");
        }
        if (!values.panNumber || values.panNumber.length < 10) {
          missingFields.push("Partner PAN Number (Identity tab)");
        }
        if (!values.partnerName) {
          missingFields.push("Partner Name (Identity tab)");
        }
      }
      if (values.businessType === "other") {
        if (!values.cinNumber) {
          missingFields.push("CIN Number (Identity tab)");
        }
      }
      if (!values.businessAddress) {
        missingFields.push("Business Address (Identity tab)");
      }
      
      if (!values.licensePlateNumber) {
        missingFields.push("License Plate Number (Vehicle tab)");
      }
      if (!values.chassisNumber) {
        missingFields.push("Chassis Number (Vehicle tab)");
      }
      if (!values.permitType) {
        missingFields.push("Permit Type (Vehicle tab)");
      }
      
      if (missingFields.length > 0) {
        toast({
          variant: "destructive",
          title: t("common.error"),
          description: `Please fill in the following required fields: ${missingFields.join(", ")}`,
        });
        // Navigate to the appropriate tab
        if (missingFields.some(f => f.includes("Identity"))) {
          setActiveTab("identity");
        } else if (missingFields.some(f => f.includes("Vehicle"))) {
          setActiveTab("vehicle");
        }
        return;
      }
      
      // Save form data immediately before submit
      try {
        setAutoSaveStatus("saving");
        await apiRequest("PATCH", "/api/carrier/onboarding/draft", values);
      } catch (error) {
        // Continue with submit even if save fails - server will validate
      }
    }
    
    submitMutation.mutate();
  };

  const getStatusBadge = () => {
    const status = onboardingStatus?.status;
    if (!status || status === "draft") return null;
    
    const variants: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; icon: any }> = {
      pending: { variant: "secondary", icon: Clock },
      under_review: { variant: "default", icon: Shield },
      approved: { variant: "default", icon: Check },
      rejected: { variant: "destructive", icon: AlertCircle },
      on_hold: { variant: "outline", icon: AlertCircle },
    };
    
    const config = variants[status] || { variant: "secondary" as const, icon: Clock };
    const Icon = config.icon;
    
    return (
      <Badge variant={config.variant} className="gap-1">
        <Icon className="h-3 w-3" />
        {t(`carrierOnboarding.status.${status}`)}
      </Badge>
    );
  };

  const canEdit = !onboardingStatus?.status || ["draft", "on_hold", "rejected", "pending", "under_review"].includes(onboardingStatus.status);

  if (isLoadingStatus) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (onboardingStatus?.status === "approved") {
    return (
      <div className="container max-w-2xl py-12">
        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-green-100 flex items-center justify-center">
              <Check className="h-8 w-8 text-green-600" />
            </div>
            <CardTitle className="text-2xl">{t("carrierOnboarding.approved")}</CardTitle>
            <CardDescription>{t("carrierOnboarding.approvedDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button onClick={() => setLocation("/carrier/loads")} data-testid="button-go-marketplace">
              {t("carrierOnboarding.goToMarketplace")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Removed the pending/under_review block - carriers can now edit while pending

  return (
    <div className="container max-w-4xl py-8">
      <div className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">{t("carrierOnboarding.title")}</h1>
            <p className="text-muted-foreground mt-2">{t("carrierOnboarding.subtitle")}</p>
          </div>
          <div className="flex items-center gap-4">
            {getStatusBadge()}
            {autoSaveStatus === "saving" && (
              <span className="text-sm text-muted-foreground flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t("common.saving")}
              </span>
            )}
            {autoSaveStatus === "saved" && (
              <span className="text-sm text-green-600 flex items-center gap-1">
                <Check className="h-3 w-3" />
                {t("common.saved")}
              </span>
            )}
          </div>
        </div>

        {(onboardingStatus?.status === "pending" || onboardingStatus?.status === "under_review") && (
          <Card className="mt-4 border-blue-300 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-800">
            <CardContent className="pt-4">
              <div className="flex items-start gap-3">
                <Clock className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5" />
                <div>
                  <p className="font-medium text-blue-700 dark:text-blue-300">{t("carrierOnboarding.pendingReview")}</p>
                  <p className="text-sm text-blue-600 dark:text-blue-400">{t("carrierOnboarding.pendingReviewDesc")} You can still make edits and resubmit.</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {onboardingStatus?.status === "rejected" && onboardingStatus.rejectionReason && (
          <Card className="mt-4 border-destructive">
            <CardContent className="pt-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-destructive mt-0.5" />
                <div>
                  <p className="font-medium text-destructive">{t("carrierOnboarding.rejectedReason")}</p>
                  <p className="text-sm text-muted-foreground">{onboardingStatus.rejectionReason}</p>
                  <p className="text-sm text-muted-foreground mt-2">
                    For assistance, please contact us at <a href="tel:+919876543210" className="text-primary font-medium underline">+91 98765 43210</a>
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {onboardingStatus?.status === "on_hold" && (
          <Card className="mt-4 border-yellow-500 bg-yellow-50 dark:bg-yellow-950/20">
            <CardContent className="pt-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-yellow-600 mt-0.5" />
                <div>
                  <p className="font-medium text-yellow-700 dark:text-yellow-500">Your verification is on hold</p>
                  {onboardingStatus.notes ? (
                    <p className="text-sm mt-1">{onboardingStatus.notes}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground mt-1">Please review and update your information below, then resubmit for review.</p>
                  )}
                  <p className="text-sm text-muted-foreground mt-2">
                    For assistance, please contact support at <a href="tel:+919876543210" className="text-primary font-medium underline">+91 98765 43210</a>
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="flex items-center gap-4">
            {carrierType === "solo" ? (
              <>
                <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <User className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold">{t("carrierOnboarding.soloOperator")}</h3>
                  <p className="text-sm text-muted-foreground">{t("carrierOnboarding.soloDesc")}</p>
                </div>
              </>
            ) : (
              <>
                <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <Building2 className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold">{t("carrierOnboarding.fleetCompany")}</h3>
                  <p className="text-sm text-muted-foreground">{t("carrierOnboarding.fleetDesc")}</p>
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {carrierType === "solo" ? (
        <Form {...soloForm} key="solo-form">
          <form>
            <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="identity" className="gap-2">
                  <IdCard className="h-4 w-4" />
                  {t("carrierOnboarding.identityTab")}
                </TabsTrigger>
                <TabsTrigger value="vehicle" className="gap-2">
                  <Truck className="h-4 w-4" />
                  {t("carrierOnboarding.vehicleTab")}
                </TabsTrigger>
                <TabsTrigger value="bank" className="gap-2">
                  <CreditCard className="h-4 w-4" />
                  Bank Details
                </TabsTrigger>
                <TabsTrigger value="documents" className="gap-2">
                  <FileText className="h-4 w-4" />
                  {t("carrierOnboarding.documentsTab")}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="identity">
                <Card>
                  <CardHeader>
                    <CardTitle>{t("carrierOnboarding.personalInfo")}</CardTitle>
                    <CardDescription>{t("carrierOnboarding.personalInfoDesc")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={soloForm.control}
                      name="aadhaarNumber"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("carrierOnboarding.aadhaarNumber")} *</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="XXXX XXXX XXXX" maxLength={12} disabled={!canEdit} data-testid="input-aadhaar" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={soloForm.control}
                      name="driverLicenseNumber"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("carrierOnboarding.driverLicense")} *</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="DL-XXXXXXXXX" disabled={!canEdit} data-testid="input-license" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={soloForm.control}
                      name="panNumber"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>PAN Number *</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="XXXXX0000X" maxLength={10} disabled={!canEdit} data-testid="input-solo-pan" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={soloForm.control}
                      name="businessAddress"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Business Address *</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="Registered office address" disabled={!canEdit} data-testid="input-solo-business-address" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={soloForm.control}
                      name="businessLocality"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Locality / Area * <span className="text-muted-foreground font-normal">(e.g. Andheri West, Bandra)</span></FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="" disabled={!canEdit} data-testid="input-solo-business-locality" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="vehicle">
                <Card>
                  <CardHeader>
                    <CardTitle>{t("carrierOnboarding.vehicleInfo")}</CardTitle>
                    <CardDescription>{t("carrierOnboarding.vehicleInfoDesc")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={soloForm.control}
                      name="licensePlateNumber"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("carrierOnboarding.licensePlate")} *</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="MH-01-AB-1234" disabled={!canEdit} data-testid="input-plate" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={soloForm.control}
                      name="chassisNumber"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("carrierOnboarding.chassisNumber")} *</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="XXXXXXXXXXXXXXXXX" disabled={!canEdit} data-testid="input-chassis" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={soloForm.control}
                      name="uniqueRegistrationNumber"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("carrierOnboarding.registrationNumber")}</FormLabel>
                          <FormControl>
                            <Input {...field} disabled={!canEdit} data-testid="input-reg-number" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={soloForm.control}
                      name="permitType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("carrierOnboarding.permitType")} *</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value} disabled={!canEdit}>
                            <FormControl>
                              <SelectTrigger data-testid="select-permit-type">
                                <SelectValue placeholder="Select permit type" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="national">{t("carrierOnboarding.nationalPermit")}</SelectItem>
                              <SelectItem value="domestic">{t("carrierOnboarding.domesticPermit")}</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="bank">
                <Card>
                  <CardHeader>
                    <CardTitle>Bank Account Details</CardTitle>
                    <CardDescription>Enter your bank details for payment processing</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={soloForm.control}
                      name="bankAccountHolderName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Account Holder Name</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="Name as per bank records" disabled={!canEdit} data-testid="input-bank-holder-name" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={soloForm.control}
                      name="bankName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Bank Name <span className="text-muted-foreground font-normal">(e.g. State Bank of India)</span></FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="" disabled={!canEdit} data-testid="input-bank-name" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={soloForm.control}
                      name="bankAccountNumber"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Account Number</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="" disabled={!canEdit} data-testid="input-bank-account" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={soloForm.control}
                      name="bankIfscCode"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>IFSC Code <span className="text-muted-foreground font-normal">(e.g. SBIN0001234)</span></FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="" disabled={!canEdit} data-testid="input-bank-ifsc" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div>
                      <label className="text-sm font-medium mb-2 block">Void Cheque / Cancelled Cheque</label>
                      <DocumentUploadWithCamera
                        value={soloForm.watch("voidChequeUrl") || ""}
                        onChange={(val) => {
                          soloForm.setValue("voidChequeUrl", val);
                          handleDocumentUpload("void_cheque", val);
                        }}
                        disabled={!canEdit}
                        documentType="void_cheque"
                      />
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="documents">
                <Card>
                  <CardHeader>
                    <CardTitle>{t("carrierOnboarding.requiredDocs")}</CardTitle>
                    <CardDescription>{t("carrierOnboarding.requiredDocsDesc")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="grid gap-4">
                      <div>
                        <label className="text-sm font-medium mb-2 block">{t("carrierOnboarding.aadhaarCard")} *</label>
                        <DocumentUploadWithCamera
                          value={soloForm.watch("aadhaarUrl") || ""}
                          onChange={(val) => {
                            soloForm.setValue("aadhaarUrl", val);
                            handleDocumentUpload("aadhaar", val);
                          }}
                          disabled={!canEdit}
                          documentType="aadhaar_card"
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-2 block">{t("carrierOnboarding.driverLicenseDoc")} *</label>
                        <DocumentUploadWithCamera
                          value={soloForm.watch("licenseUrl") || ""}
                          onChange={(val) => {
                            soloForm.setValue("licenseUrl", val);
                            handleDocumentUpload("license", val);
                          }}
                          disabled={!canEdit}
                          documentType="driver_license"
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-2 block">PAN Card *</label>
                        <DocumentUploadWithCamera
                          value={soloForm.watch("panUrl") || ""}
                          onChange={(val) => {
                            soloForm.setValue("panUrl", val);
                            handleDocumentUpload("pan", val);
                          }}
                          disabled={!canEdit}
                          documentType="pan_card"
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-2 block">{t("carrierOnboarding.permitDoc")} *</label>
                        <DocumentUploadWithCamera
                          value={soloForm.watch("permitUrl") || ""}
                          onChange={(val) => {
                            soloForm.setValue("permitUrl", val);
                            handleDocumentUpload("permit", val);
                          }}
                          disabled={!canEdit}
                          documentType="permit"
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-2 block">{t("carrierOnboarding.rcDoc")} *</label>
                        <DocumentUploadWithCamera
                          value={soloForm.watch("rcUrl") || ""}
                          onChange={(val) => {
                            soloForm.setValue("rcUrl", val);
                            handleDocumentUpload("rc", val);
                          }}
                          disabled={!canEdit}
                          documentType="registration_certificate"
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-2 block">{t("carrierOnboarding.insuranceDoc")} *</label>
                        <DocumentUploadWithCamera
                          value={soloForm.watch("insuranceUrl") || ""}
                          onChange={(val) => {
                            soloForm.setValue("insuranceUrl", val);
                            handleDocumentUpload("insurance", val);
                          }}
                          disabled={!canEdit}
                          documentType="insurance_certificate"
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-2 block">{t("carrierOnboarding.fitnessDoc")} *</label>
                        <DocumentUploadWithCamera
                          value={soloForm.watch("fitnessUrl") || ""}
                          onChange={(val) => {
                            soloForm.setValue("fitnessUrl", val);
                            handleDocumentUpload("fitness", val);
                          }}
                          disabled={!canEdit}
                          documentType="fitness_certificate"
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-2 block">TDS Declaration (Optional)</label>
                        <DocumentUploadWithCamera
                          value={soloForm.watch("tdsDeclarationUrl") || ""}
                          onChange={(val) => {
                            soloForm.setValue("tdsDeclarationUrl", val);
                            handleDocumentUpload("tds_declaration", val);
                          }}
                          disabled={!canEdit}
                          documentType="tds_declaration"
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-2 block">Selfie</label>
                        <DocumentUploadWithCamera
                          value={soloForm.watch("selfieUrl") || ""}
                          onChange={(val) => {
                            soloForm.setValue("selfieUrl", val);
                            handleDocumentUpload("selfie", val);
                          }}
                          disabled={!canEdit}
                          documentType="selfie"
                          preferCamera={true}
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-2 block">MSME / Udyam Certificate (If applicable)</label>
                        <DocumentUploadWithCamera
                          value={soloForm.watch("msmeUdyamUrl") || ""}
                          onChange={(val) => {
                            soloForm.setValue("msmeUdyamUrl", val);
                            handleDocumentUpload("msme_udyam", val);
                          }}
                          disabled={!canEdit}
                          documentType="msme_udyam"
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </form>
        </Form>
      ) : (
        <Form {...fleetForm} key="fleet-form">
          <form>
            <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="identity" className="gap-2">
                  <IdCard className="h-4 w-4" />
                  {t("carrierOnboarding.identityTab")}
                </TabsTrigger>
                <TabsTrigger value="vehicle" className="gap-2">
                  <Truck className="h-4 w-4" />
                  {t("carrierOnboarding.vehicleTab")}
                </TabsTrigger>
                <TabsTrigger value="bank" className="gap-2">
                  <CreditCard className="h-4 w-4" />
                  Bank Details
                </TabsTrigger>
                <TabsTrigger value="documents" className="gap-2">
                  <FileText className="h-4 w-4" />
                  {t("carrierOnboarding.documentsTab")}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="identity">
                <Card>
                  <CardHeader>
                    <CardTitle>{t("carrierOnboarding.personalInfo")}</CardTitle>
                    <CardDescription>{t("carrierOnboarding.personalInfoDesc")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={fleetForm.control}
                      name="businessType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Business Type *</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value || ""} disabled={!canEdit}>
                            <FormControl>
                              <SelectTrigger data-testid="select-fleet-business-type">
                                <SelectValue placeholder="Select your business type" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="sole_proprietor">Sole Proprietor</SelectItem>
                              <SelectItem value="registered_partnership">Registered Partnership</SelectItem>
                              <SelectItem value="non_registered_partnership">Non-Registered Partnership</SelectItem>
                              <SelectItem value="other">Other (Pvt Ltd, LLP, etc.)</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={fleetForm.control}
                      name="aadhaarNumber"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("carrierOnboarding.aadhaarNumber")} *</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="XXXX XXXX XXXX" maxLength={12} disabled={!canEdit} data-testid="input-fleet-aadhaar" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {fleetForm.watch("businessType") === "registered_partnership" && (
                      <>
                        {!fleetForm.watch("noGstinNumber") && (
                          <FormField
                            control={fleetForm.control}
                            name="gstinNumber"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>GSTIN Number *</FormLabel>
                                <FormControl>
                                  <Input {...field} placeholder="22XXXXX0000X1Z5" maxLength={15} disabled={!canEdit} data-testid="input-fleet-gstin" />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        )}
                        <FormField
                          control={fleetForm.control}
                          name="noGstinNumber"
                          render={({ field }) => (
                            <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
                              <FormControl>
                                <Checkbox
                                  checked={field.value}
                                  onCheckedChange={(checked) => {
                                    field.onChange(checked);
                                    if (checked) {
                                      fleetForm.setValue("gstinNumber", "");
                                    }
                                  }}
                                  disabled={!canEdit}
                                  data-testid="checkbox-no-gstin"
                                />
                              </FormControl>
                              <div className="space-y-1 leading-none">
                                <FormLabel className="cursor-pointer">
                                  I do not have GSTIN Number
                                </FormLabel>
                              </div>
                            </FormItem>
                          )}
                        />
                      </>
                    )}
                    {fleetForm.watch("businessType") === "non_registered_partnership" && (
                      <>
                        <div className="border-t pt-4 mt-4">
                          <p className="text-sm font-medium mb-3">Partner Details (for one partner)</p>
                        </div>
                        <FormField
                          control={fleetForm.control}
                          name="partnerName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Partner Full Name *</FormLabel>
                              <FormControl>
                                <Input {...field} placeholder="Full name of partner" disabled={!canEdit} data-testid="input-fleet-partner-name" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={fleetForm.control}
                          name="driverLicenseNumber"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Partner Driver License Number *</FormLabel>
                              <FormControl>
                                <Input {...field} placeholder="DL-XXXXXXXXX" disabled={!canEdit} data-testid="input-fleet-license" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={fleetForm.control}
                          name="panNumber"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Partner PAN Number *</FormLabel>
                              <FormControl>
                                <Input {...field} placeholder="XXXXX0000X" maxLength={10} disabled={!canEdit} data-testid="input-fleet-pan" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </>
                    )}
                    {fleetForm.watch("businessType") === "other" && (
                      <FormField
                        control={fleetForm.control}
                        name="cinNumber"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>CIN Number *</FormLabel>
                            <FormControl>
                              <Input {...field} placeholder="U12345MH2020PTC123456" disabled={!canEdit} data-testid="input-fleet-cin" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                    <FormField
                      control={fleetForm.control}
                      name="businessAddress"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Business Address *</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="Registered office address" disabled={!canEdit} data-testid="input-fleet-business-address" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={fleetForm.control}
                      name="businessLocality"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Locality / Area * <span className="text-muted-foreground font-normal">(e.g. Andheri West, Bandra)</span></FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="" disabled={!canEdit} data-testid="input-fleet-business-locality" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={fleetForm.control}
                      name="fleetSize"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Fleet Size (Number of Trucks) *</FormLabel>
                          <FormControl>
                            <Input 
                              type="number" 
                              min={1} 
                              placeholder="Number of trucks in your fleet"
                              {...field} 
                              value={field.value === 0 ? "" : field.value}
                              onChange={(e) => {
                                const val = e.target.value;
                                field.onChange(val === "" ? "" : parseInt(val) || "");
                              }}
                              disabled={!canEdit} 
                              data-testid="input-fleet-size" 
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="vehicle">
                <Card>
                  <CardHeader>
                    <CardTitle>{t("carrierOnboarding.vehicleInfo")}</CardTitle>
                    <CardDescription>Provide details for one of your trucks</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={fleetForm.control}
                      name="licensePlateNumber"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("carrierOnboarding.licensePlate")} *</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="MH-01-AB-1234" disabled={!canEdit} data-testid="input-fleet-plate" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={fleetForm.control}
                      name="chassisNumber"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("carrierOnboarding.chassisNumber")} *</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="XXXXXXXXXXXXXXXXX" disabled={!canEdit} data-testid="input-fleet-chassis" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={fleetForm.control}
                      name="uniqueRegistrationNumber"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("carrierOnboarding.registrationNumber")}</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="RC number" disabled={!canEdit} data-testid="input-fleet-reg-number" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={fleetForm.control}
                      name="permitType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("carrierOnboarding.permitType")} *</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value} disabled={!canEdit}>
                            <FormControl>
                              <SelectTrigger data-testid="select-fleet-permit-type">
                                <SelectValue placeholder="Select permit type" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="national">{t("carrierOnboarding.nationalPermit")}</SelectItem>
                              <SelectItem value="domestic">{t("carrierOnboarding.domesticPermit")}</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="bank">
                <Card>
                  <CardHeader>
                    <CardTitle>Bank Account Details</CardTitle>
                    <CardDescription>Enter your company bank details for payment processing</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={fleetForm.control}
                      name="bankAccountHolderName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Account Holder Name</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="Company name as per bank records" disabled={!canEdit} data-testid="input-fleet-bank-holder-name" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={fleetForm.control}
                      name="bankName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Bank Name <span className="text-muted-foreground font-normal">(e.g. State Bank of India)</span></FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="" disabled={!canEdit} data-testid="input-fleet-bank-name" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={fleetForm.control}
                      name="bankAccountNumber"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Account Number</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="" disabled={!canEdit} data-testid="input-fleet-bank-account" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={fleetForm.control}
                      name="bankIfscCode"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>IFSC Code <span className="text-muted-foreground font-normal">(e.g. SBIN0001234)</span></FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="" disabled={!canEdit} data-testid="input-fleet-bank-ifsc" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div>
                      <label className="text-sm font-medium mb-2 block">Void Cheque / Cancelled Cheque</label>
                      <DocumentUploadWithCamera
                        value={fleetForm.watch("voidChequeUrl") || ""}
                        onChange={(val) => {
                          fleetForm.setValue("voidChequeUrl", val);
                          handleDocumentUpload("void_cheque", val);
                        }}
                        disabled={!canEdit}
                        documentType="void_cheque"
                      />
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="documents">
                <Card>
                  <CardHeader>
                    <CardTitle>{t("carrierOnboarding.requiredDocs")}</CardTitle>
                    <CardDescription>Upload your identity and vehicle documents for verification</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="grid gap-4">
                      <div>
                        <label className="text-sm font-medium mb-2 block">Aadhaar Card *</label>
                        <DocumentUploadWithCamera
                          value={fleetForm.watch("aadhaarUrl") || ""}
                          onChange={(val) => {
                            fleetForm.setValue("aadhaarUrl", val);
                            handleDocumentUpload("aadhaar", val);
                          }}
                          disabled={!canEdit}
                          documentType="aadhaar"
                        />
                      </div>
                      {fleetForm.watch("businessType") === "registered_partnership" && !fleetForm.watch("noGstinNumber") && (
                        <div>
                          <label className="text-sm font-medium mb-2 block">GSTIN Certificate *</label>
                          <DocumentUploadWithCamera
                            value={fleetForm.watch("gstinUrl") || ""}
                            onChange={(val) => {
                              fleetForm.setValue("gstinUrl", val);
                              handleDocumentUpload("gstin", val);
                            }}
                            disabled={!canEdit}
                            documentType="gstin_certificate"
                          />
                        </div>
                      )}
                      {fleetForm.watch("businessType") === "non_registered_partnership" && (
                        <>
                          <div>
                            <label className="text-sm font-medium mb-2 block">Partner Driver's License *</label>
                            <DocumentUploadWithCamera
                              value={fleetForm.watch("licenseUrl") || ""}
                              onChange={(val) => {
                                fleetForm.setValue("licenseUrl", val);
                                handleDocumentUpload("license", val);
                              }}
                              disabled={!canEdit}
                              documentType="license"
                            />
                          </div>
                          <div>
                            <label className="text-sm font-medium mb-2 block">Partner PAN Card *</label>
                            <DocumentUploadWithCamera
                              value={fleetForm.watch("panUrl") || ""}
                              onChange={(val) => {
                                fleetForm.setValue("panUrl", val);
                                handleDocumentUpload("pan", val);
                              }}
                              disabled={!canEdit}
                              documentType="pan_card"
                            />
                          </div>
                        </>
                      )}
                      {fleetForm.watch("businessType") === "other" && (
                        <div>
                          <label className="text-sm font-medium mb-2 block">CIN Certificate *</label>
                          <DocumentUploadWithCamera
                            value={fleetForm.watch("cinUrl") || ""}
                            onChange={(val) => {
                              fleetForm.setValue("cinUrl", val);
                              handleDocumentUpload("cin", val);
                            }}
                            disabled={!canEdit}
                            documentType="cin"
                          />
                        </div>
                      )}
                      <div>
                        <label className="text-sm font-medium mb-2 block">TDS Declaration (Optional)</label>
                        <DocumentUploadWithCamera
                          value={fleetForm.watch("tdsDeclarationUrl") || ""}
                          onChange={(val) => {
                            fleetForm.setValue("tdsDeclarationUrl", val);
                            handleDocumentUpload("tds_declaration", val);
                          }}
                          disabled={!canEdit}
                          documentType="tds_declaration"
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-2 block">{t("onboarding.officePhoto")}</label>
                        <p className="text-sm text-red-600 font-medium mb-2">
                          {t("onboarding.officeSelfieNote")}
                        </p>
                        <DocumentUploadWithCamera
                          value={fleetForm.watch("addressProofUrl") || ""}
                          onChange={(val) => {
                            fleetForm.setValue("addressProofUrl", val);
                            handleDocumentUpload("address_proof", val);
                          }}
                          disabled={!canEdit}
                          documentType="address_proof"
                          preferCamera={true}
                        />
                        <p className="text-xs text-muted-foreground mt-1">{t("onboarding.addressProofDesc")}</p>
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-2 block">Selfie</label>
                        <DocumentUploadWithCamera
                          value={fleetForm.watch("selfieUrl") || ""}
                          onChange={(val) => {
                            fleetForm.setValue("selfieUrl", val);
                            handleDocumentUpload("selfie", val);
                          }}
                          disabled={!canEdit}
                          documentType="selfie"
                          preferCamera={true}
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-2 block">{t("carrierOnboarding.rcDoc")} *</label>
                        <DocumentUploadWithCamera
                          value={fleetForm.watch("rcUrl") || ""}
                          onChange={(val) => {
                            fleetForm.setValue("rcUrl", val);
                            handleDocumentUpload("rc", val);
                          }}
                          disabled={!canEdit}
                          documentType="rc"
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-2 block">{t("carrierOnboarding.insuranceDoc")} *</label>
                        <DocumentUploadWithCamera
                          value={fleetForm.watch("insuranceUrl") || ""}
                          onChange={(val) => {
                            fleetForm.setValue("insuranceUrl", val);
                            handleDocumentUpload("insurance", val);
                          }}
                          disabled={!canEdit}
                          documentType="insurance"
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-2 block">{t("carrierOnboarding.fitnessDoc")} *</label>
                        <DocumentUploadWithCamera
                          value={fleetForm.watch("fitnessUrl") || ""}
                          onChange={(val) => {
                            fleetForm.setValue("fitnessUrl", val);
                            handleDocumentUpload("fitness", val);
                          }}
                          disabled={!canEdit}
                          documentType="fitness"
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-2 block">MSME / Udyam Certificate (If applicable)</label>
                        <DocumentUploadWithCamera
                          value={fleetForm.watch("msmeUdyamUrl") || ""}
                          onChange={(val) => {
                            fleetForm.setValue("msmeUdyamUrl", val);
                            handleDocumentUpload("msme_udyam", val);
                          }}
                          disabled={!canEdit}
                          documentType="msme_udyam"
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </form>
        </Form>
      )}

      {canEdit && (
        <div className="mt-8 flex justify-end">
          <Button 
            size="lg" 
            onClick={handleSubmit}
            disabled={submitMutation.isPending}
            data-testid="button-submit-onboarding"
          >
            {submitMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("common.submitting")}
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                {t("carrierOnboarding.submitForReview")}
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
