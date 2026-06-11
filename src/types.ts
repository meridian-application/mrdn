export type AppTab = "home" | "feed" | "metrics" | "profile";
export type HomeSection = "recommended" | "favorites";
export type MetricType = "glucose" | "weight" | "steps";

export interface SurveyAnswers {
  diabetesType?: string;
  gender?: string;
  age?: number;
  therapy?: string;
  mealsPerDay?: string;
  excludedProducts?: string[];
  personalRestrictions?: string;
  hypoglycemia?: string;
}

export interface MetricEntry {
  id: string;
  type: MetricType;
  value: number;
  unit: string;
  note: string;
  timestamp: string;
}

export interface UserRecord {
  id: string;
  vkId?: string;
  fullName: string;
  email: string;
  password: string;
  region: string;
  createdAt: string;
  survey: SurveyAnswers;
  onboardingComplete: boolean;
  favorites: string[];
  metrics: MetricEntry[];
}

export interface PersistedState {
  accounts: UserRecord[];
  currentUserId: string | null;
}

export interface Recipe {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  category: string;
  cookMinutes: number;
  calories: number;
  carbs: number;
  protein: number;
  fat: number;
  gi: number;
  xe: number;
  tags: string[];
  safeFor: string[];
  therapyCompatibility: string[];
  focus: string;
  ingredients: string[];
  steps: string[];
  cardImage?: string;
  cardImagePosition?: string;
  palette: {
    background: string;
    accent: string;
    imageGlow: string;
  };
}

export interface Article {
  id: string;
  title: string;
  label: string;
  excerpt: string;
  readMinutes: number;
  body: string[];
  highlight: string;
}

export interface VKUserProfile {
  id?: number;
  first_name?: string;
  last_name?: string;
  photo_200?: string;
}
