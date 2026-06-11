import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  hasBackendSession,
  isBackendConfigured,
  loadBackendState,
  loginBackendUser,
  logoutBackend,
  registerBackendUser,
  saveBackendState,
} from "./api";
import { articles, recipes } from "./data";
import { STORAGE_KEY, defaultState, loadState, parsePersistedState, saveState } from "./storage";
import type {
  AppTab,
  HomeSection,
  MetricEntry,
  MetricType,
  PersistedState,
  Recipe,
  SurveyAnswers,
  UserRecord,
  VKUserProfile,
} from "./types";
import { getVKStorageValue, getVKStorageValues, initVKMiniApp, setVKStorageValue } from "./vk";

type AuthView = "launch" | "login" | "preSurvey" | "register";
type SurveyMode = "intro" | "questions" | "complete";
type RecipeCatalogTab = "Все рецепты" | "Фастфуд" | "Овощи" | "Супы" | "Рыба";
type SurveyQuestion =
  | {
      key:
        | "diabetesType"
        | "gender"
        | "therapy"
        | "mealsPerDay"
        | "hypoglycemia";
      title: string;
      description?: string;
      kind: "choice";
      options: string[];
      required?: boolean;
    }
  | {
      key: "age";
      title: string;
      description?: string;
      kind: "number";
      placeholder: string;
      required?: boolean;
    }
  | {
      key: "excludedProducts";
      secondaryKey: "personalRestrictions";
      title: string;
      description?: string;
      kind: "nutrition";
      options: string[];
      secondaryTitle: string;
      secondaryOptions: string[];
      required?: boolean;
    };

const surveyQuestions: SurveyQuestion[] = [
  {
    key: "diabetesType",
    title: "Тип диабета",
    description:
      "Мы строго сохраняем конфиденциальность. Эти данные нужны для подбора безопасных рецептов.",
    kind: "choice",
    options: [
      "Сахарный Диабет 1 типа",
      "Сахарный Диабет 2 типа",
      "Предиабет / Инсулинорезистентность",
      "Гестационный диабет",
      "Пока не диагностирован, но есть риск",
    ],
  },
  {
    key: "gender",
    title: "Выберите пол:",
    kind: "choice",
    options: ["Мужской", "Женский"],
  },
  {
    key: "age",
    title: "Введите Ваш возраст:",
    kind: "number",
    placeholder: "Например, 32",
  },
  {
    key: "therapy",
    title: "Какой тип терапии вы используете?",
    kind: "choice",
    options: [
      "Инсулинотерапия (инсулин)",
      "Сахароснижающие препараты (таблетки)",
      "Только диета и физическая активность (без лекарств)",
      "Комбинированная терапия (таблетки + инсулин)",
      "Ничего не использую",
    ],
  },
  {
    key: "mealsPerDay",
    title: "Сколько раз в день вы обычно едите?",
    kind: "choice",
    options: [
      "3 раза (завтрак, обед и ужин)",
      "4-5 раз (с легкими перекусами)",
      "6 и более раз",
    ],
  },
  {
    key: "excludedProducts",
    secondaryKey: "personalRestrictions",
    title: "Питание и ограничения",
    description:
      "Отметьте продукты, которые следует исключить из рациона. Можно выбрать несколько пунктов или пропустить этот шаг.",
    kind: "nutrition",
    options: ["Соя", "Мед", "Яйца", "Орехи", "Глютен", "Курица", "Лактоза", "Морепродукты/Рыба"],
    secondaryTitle: "Какие продукты вы исключаете по этическим или личным причинам?",
    secondaryOptions: ["Вегетарианство", "Веганство", "Я не ем свинину", "Нет ограничений"],
    required: false,
  },
  {
    key: "hypoglycemia",
    title: "Бывают ли у вас гипогликемии?",
    kind: "choice",
    options: ["Никогда", "Да, иногда", "Да, часто"],
  },
];

const recipeCatalogTabs: RecipeCatalogTab[] = [
  "Все рецепты",
  "Фастфуд",
  "Овощи",
  "Супы",
  "Рыба",
];

const metricUnits: Record<MetricType, string> = {
  glucose: "ммоль/л",
  weight: "кг",
  steps: "шагов",
};

const metricPlaceholders: Record<MetricType, string> = {
  glucose: "Например, 5.8",
  weight: "Например, 74.2",
  steps: "Например, 8432",
};

const MIN_SURVEY_AGE = 14;
const MAX_SURVEY_AGE = 120;
const VK_STORAGE_META_KEY = `${STORAGE_KEY}:meta`;
const VK_STORAGE_PART_KEY_PREFIX = `${STORAGE_KEY}:part:`;
const VK_STORAGE_CHUNK_SIZE = 3000;

type RemoteStateMeta = {
  parts: number;
};

function hasPersistedData(state: PersistedState) {
  return state.accounts.length > 0 || Boolean(state.currentUserId);
}

function isSurveyValuePresent(value: SurveyAnswers[keyof SurveyAnswers]) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return value !== undefined && value !== null && value !== "";
}

function isSurveyQuestionAnswered(question: SurveyQuestion, survey: SurveyAnswers) {
  if (question.kind === "nutrition") {
    return (
      isSurveyValuePresent(survey[question.key]) ||
      isSurveyValuePresent(survey[question.secondaryKey])
    );
  }

  return isSurveyValuePresent(survey[question.key]);
}

function getAnsweredSurveyCount(survey: SurveyAnswers) {
  return surveyQuestions.reduce((count, question) => {
    return isSurveyQuestionAnswered(question, survey) ? count + 1 : count;
  }, 0);
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function getAccountCompletenessScore(account: UserRecord) {
  return (
    getAnsweredSurveyCount(account.survey) * 3 +
    ((account.onboardingComplete || isSurveyComplete(account.survey)) ? 50 : 0) +
    account.metrics.length * 2 +
    account.favorites.length +
    (account.fullName.trim() ? 2 : 0) +
    (account.region.trim() ? 1 : 0) +
    (account.password ? 1 : 0)
  );
}

function pickPreferredAccount(left: UserRecord, right: UserRecord) {
  const leftScore = getAccountCompletenessScore(left);
  const rightScore = getAccountCompletenessScore(right);

  if (leftScore !== rightScore) {
    return rightScore > leftScore ? right : left;
  }

  return new Date(right.createdAt).getTime() >= new Date(left.createdAt).getTime()
    ? right
    : left;
}

function mergePersistedStates(localState: PersistedState, remoteState: PersistedState): PersistedState {
  const accountMap = new Map<string, UserRecord>();
  const resolvedIds = new Map<string, string>();

  const registerAccount = (account: UserRecord) => {
    const key = account.vkId ? `vk:${account.vkId}` : normalizeEmail(account.email) || account.id;
    const existing = accountMap.get(key);

    if (!existing) {
      accountMap.set(key, account);
      resolvedIds.set(account.id, account.id);
      return;
    }

    const preferred = pickPreferredAccount(existing, account);
    accountMap.set(key, preferred);
    resolvedIds.set(existing.id, preferred.id);
    resolvedIds.set(account.id, preferred.id);
  };

  [...localState.accounts, ...remoteState.accounts].forEach(registerAccount);

  const accounts = Array.from(accountMap.values()).sort(
    (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  );
  const accountIds = new Set(accounts.map((account) => account.id));
  const currentUserCandidates = [remoteState.currentUserId, localState.currentUserId].filter(
    Boolean
  ) as string[];
  const currentUserId =
    currentUserCandidates
      .map((id) => resolvedIds.get(id) ?? id)
      .find((id) => accountIds.has(id)) ?? null;

  return {
    accounts,
    currentUserId,
  };
}

function isSameState(left: PersistedState, right: PersistedState) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function getStateCompletenessScore(state: PersistedState) {
  return state.accounts.reduce((score, account) => {
    const onboardingComplete = account.onboardingComplete || isSurveyComplete(account.survey);

    return (
      score +
      getAnsweredSurveyCount(account.survey) * 3 +
      (onboardingComplete ? 50 : 0) +
      account.metrics.length * 2 +
      account.favorites.length +
      (state.currentUserId === account.id ? 5 : 0)
    );
  }, 0);
}

function shouldUseRemoteState(localState: PersistedState, remoteState: PersistedState) {
  if (!hasPersistedData(remoteState)) {
    return false;
  }

  if (!hasPersistedData(localState)) {
    return true;
  }

  if (remoteState.accounts.length > localState.accounts.length) {
    return true;
  }

  if (!localState.currentUserId && Boolean(remoteState.currentUserId)) {
    return true;
  }

  return getStateCompletenessScore(remoteState) > getStateCompletenessScore(localState);
}

function buildRemoteChunkKeys(parts: number) {
  return Array.from({ length: parts }, (_, index) => `${VK_STORAGE_PART_KEY_PREFIX}${index}`);
}

function splitPersistedPayload(value: string, chunkSize = VK_STORAGE_CHUNK_SIZE) {
  const parts: string[] = [];

  for (let index = 0; index < value.length; index += chunkSize) {
    parts.push(value.slice(index, index + chunkSize));
  }

  return parts.length ? parts : [""];
}

function parseRemoteStateMeta(raw: string | null): RemoteStateMeta | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as RemoteStateMeta;

    if (!Number.isInteger(parsed.parts) || parsed.parts < 1) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

async function loadRemotePersistedState() {
  const meta = parseRemoteStateMeta(await getVKStorageValue(VK_STORAGE_META_KEY));

  if (meta) {
    const chunkKeys = buildRemoteChunkKeys(meta.parts);
    const chunkMap = await getVKStorageValues(chunkKeys);
    const payload = chunkKeys.map((key) => chunkMap[key] ?? "").join("");
    return parsePersistedState(payload);
  }

  return parsePersistedState(await getVKStorageValue(STORAGE_KEY));
}

async function saveRemotePersistedState(state: PersistedState) {
  const payload = JSON.stringify(state);
  const chunks = splitPersistedPayload(payload);
  const previousMeta = parseRemoteStateMeta(await getVKStorageValue(VK_STORAGE_META_KEY));
  let saved = await setVKStorageValue(
    VK_STORAGE_META_KEY,
    JSON.stringify({
      parts: chunks.length,
    })
  );

  for (const [index, chunk] of chunks.entries()) {
    saved = (await setVKStorageValue(`${VK_STORAGE_PART_KEY_PREFIX}${index}`, chunk)) && saved;
  }

  if (previousMeta && previousMeta.parts > chunks.length) {
    for (let index = chunks.length; index < previousMeta.parts; index += 1) {
      saved = (await setVKStorageValue(`${VK_STORAGE_PART_KEY_PREFIX}${index}`, "")) && saved;
    }
  }

  saved = (await setVKStorageValue(STORAGE_KEY, chunks.length === 1 ? payload : "")) && saved;
  return saved;
}

async function restoreVkCurrentUser(state: PersistedState, profile: VKUserProfile | null) {
  if (!profile?.id || state.currentUserId) {
    return state;
  }

  const vkId = String(profile.id);
  const existing = state.accounts.find((account) => account.vkId === vkId);

  if (!existing) {
    return state;
  }

  const nextState = {
    ...state,
    currentUserId: existing.id,
  };

  await saveState(nextState);
  return nextState;
}

export default function App() {
  const [state, setState] = useState<PersistedState>(defaultState);
  const [authView, setAuthView] = useState<AuthView>("launch");
  const [activeTab, setActiveTab] = useState<AppTab>("home");
  const [homeSection, setHomeSection] = useState<HomeSection>("recommended");
  const [recipeCatalogTab, setRecipeCatalogTab] = useState<RecipeCatalogTab>("Все рецепты");
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearch = useDeferredValue(searchQuery);
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [metricsRange, setMetricsRange] = useState<"7d" | "30d">("7d");
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [registerForm, setRegisterForm] = useState({
    fullName: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [authError, setAuthError] = useState<string | null>(null);
  const [surveyMode, setSurveyMode] = useState<SurveyMode>("intro");
  const [showSurveyCompletionScreen, setShowSurveyCompletionScreen] = useState(false);
  const [surveyStepIndex, setSurveyStepIndex] = useState(0);
  const [surveyDraft, setSurveyDraft] = useState<SurveyAnswers>({});
  const [surveyError, setSurveyError] = useState<string | null>(null);
  const [metricFormOpen, setMetricFormOpen] = useState(false);
  const [metricDraft, setMetricDraft] = useState<{
    type: MetricType;
    value: string;
    note: string;
  }>({
    type: "glucose",
    value: "",
    note: "",
  });
  const [metricError, setMetricError] = useState<string | null>(null);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [profileDraft, setProfileDraft] = useState({
    fullName: "",
    region: "Москва",
  });
  const [vkUser, setVkUser] = useState<VKUserProfile | null>(null);
  const [storageHydrated, setStorageHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const profile = await initVKMiniApp();

      if (cancelled) {
        return;
      }

      if (profile) {
        setVkUser(profile);
      }

      const backendState = await loadBackendState(profile).catch(() => null);
      const loadedState = backendState ?? (await loadState());
      const resolvedState = await restoreVkCurrentUser(loadedState, profile);

      if (cancelled) {
        return;
      }

      stateRef.current = resolvedState;
      setState(resolvedState);
      setStorageHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const currentUser =
    state.accounts.find((account) => account.id === state.currentUserId) ?? null;
  const currentUserOnboardingComplete = currentUser
    ? currentUser.onboardingComplete || isSurveyComplete(currentUser.survey)
    : false;
  const selectedRecipe =
    recipes.find((recipe) => recipe.id === selectedRecipeId) ?? null;
  const selectedArticle =
    articles.find((article) => article.id === selectedArticleId) ?? null;

  const greetingName = currentUser?.fullName ?? buildVKName(vkUser) ?? "друг";
  const availableRecipeIds = new Set(recipes.map((recipe) => recipe.id));
  const favoriteIds = new Set(
    (currentUser?.favorites ?? []).filter((recipeId) => availableRecipeIds.has(recipeId))
  );
  const favoritesCount = favoriteIds.size;
  const stateRef = useRef(state);

  const persistStateSnapshot = async (nextState: PersistedState, awaitRemote = false) => {
    await saveState(nextState);

    if (!storageHydrated) {
      return true;
    }

    const remoteRequest = Promise.all([
      saveRemotePersistedState(nextState),
      saveBackendState(nextState),
    ]).then((results) => results.every(Boolean));

    if (awaitRemote) {
      return remoteRequest;
    }

    void remoteRequest;
    return true;
  };

  const commitState = async (
    nextState: PersistedState,
    options: {
      awaitRemote?: boolean;
    } = {}
  ) => {
    stateRef.current = nextState;
    setState(nextState);
    return persistStateSnapshot(nextState, Boolean(options.awaitRemote));
  };

  const updatePersistedState = async (
    transform: (current: PersistedState) => PersistedState,
    options: {
      awaitRemote?: boolean;
    } = {}
  ) => {
    const nextState = transform(stateRef.current);
    await commitState(nextState, options);
    return nextState;
  };

  const syncStateFromRemote = async () => {
    const remoteState = await loadRemotePersistedState();

    if (!remoteState) {
      return stateRef.current;
    }

    const mergedState = mergePersistedStates(stateRef.current, remoteState);

    if (!isSameState(stateRef.current, mergedState)) {
      await commitState(mergedState);
    }

    return mergedState;
  };

  const searchableRecipes = recipes
    .filter((recipe) => {
      const normalizedQuery = deferredSearch.trim().toLowerCase();

      if (!normalizedQuery) {
        return true;
      }

      const haystack = [
        recipe.title,
        recipe.subtitle,
        recipe.description,
        recipe.category,
        recipe.focus,
        ...recipe.tags,
        ...recipe.ingredients,
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  const recommendedRecipes = [...searchableRecipes]
    .sort(
      (left, right) =>
        getRecipeScore(right, currentUser?.survey ?? {}) -
        getRecipeScore(left, currentUser?.survey ?? {})
    );
  const favoriteRecipes = recommendedRecipes.filter((recipe) => favoriteIds.has(recipe.id));
  const heroRecipe =
    homeSection === "favorites" ? favoriteRecipes[0] ?? null : recommendedRecipes[0] ?? null;
  const catalogSourceRecipes =
    homeSection === "favorites"
      ? favoriteRecipes.slice(heroRecipe ? 1 : 0)
      : searchableRecipes.filter((recipe) => recipe.id !== heroRecipe?.id);
  const catalogRecipes =
    homeSection === "favorites"
      ? catalogSourceRecipes
      : catalogSourceRecipes.filter((recipe) => matchesRecipeCatalogTab(recipe, recipeCatalogTab));

  const glucoseEntries = (currentUser?.metrics ?? []).filter(
    (entry) => entry.type === "glucose"
  );
  const weightEntries = (currentUser?.metrics ?? []).filter(
    (entry) => entry.type === "weight"
  );
  const stepsEntries = (currentUser?.metrics ?? []).filter(
    (entry) => entry.type === "steps"
  );
  const recentGlucoseEntries = glucoseEntries.slice(0, metricsRange === "7d" ? 7 : 30);
  const averageGlucose = getAverage(recentGlucoseEntries.map((entry) => entry.value));
  const latestWeight = weightEntries[0] ?? null;
  const previousWeight = weightEntries[1] ?? null;
  const latestSteps = stepsEntries[0] ?? null;
  const chartPoints = buildChartPoints(recentGlucoseEntries, metricsRange);
  const hasGlucoseData = recentGlucoseEntries.length > 0;
  const hasMetricData = (currentUser?.metrics.length ?? 0) > 0;
  const glucoseStatus = !hasGlucoseData
    ? "Нет данных"
    : averageGlucose <= 6.0
      ? "Норма"
      : averageGlucose <= 7.2
        ? "Контроль"
        : "Внимание";

  useEffect(() => {
    void initVKMiniApp().then((profile) => {
      if (!profile) {
        return;
      }

      setVkUser(profile);
    });
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (hasBackendSession()) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const remoteState = await loadRemotePersistedState();

      if (cancelled) {
        return;
      }

      if (remoteState) {
        const mergedState = mergePersistedStates(stateRef.current, remoteState);

        if (!isSameState(stateRef.current, mergedState)) {
          stateRef.current = mergedState;
          setState(mergedState);
          await saveState(mergedState);
        }
      }

      setStorageHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageHydrated) {
      return;
    }

    const save = async () => {
      await saveState(state);
      void saveRemotePersistedState(state);
      void saveBackendState(state);
    };
    save();
  }, [state, storageHydrated]);

  useEffect(() => {
    if (!vkUser) {
      return;
    }

    const suggestedName = buildVKName(vkUser);

    if (!suggestedName) {
      return;
    }

    setRegisterForm((current) =>
      current.fullName ? current : { ...current, fullName: suggestedName }
    );
  }, [vkUser]);

  useEffect(() => {
    if (!currentUser) {
      setSearchQuery("");
      setSelectedRecipeId(null);
      setSelectedArticleId(null);
      setMetricFormOpen(false);
      setProfileEditorOpen(false);
      setMetricError(null);
      setSurveyDraft({});
      setSurveyMode("intro");
      setSurveyStepIndex(0);
      setSurveyError(null);
      setShowSurveyCompletionScreen(false);
      return;
    }

    setSurveyDraft(currentUser.survey);
    setProfileDraft({
      fullName: currentUser.fullName,
      region: currentUser.region,
    });
    setSearchQuery("");
    setSelectedRecipeId(null);
    setSelectedArticleId(null);
    setHomeSection("recommended");
    setRecipeCatalogTab("Все рецепты");
    setActiveTab("home");
    setMetricsRange("7d");
    setMetricFormOpen(false);
    setMetricError(null);

    if (currentUserOnboardingComplete) {
      if (!currentUser.onboardingComplete) {
        syncCurrentUser((user) => ({
          ...user,
          onboardingComplete: true,
        }));
      }

      setSurveyMode("complete");
      setSurveyStepIndex(surveyQuestions.length);
      setShowSurveyCompletionScreen(false);
      return;
    }

    setSurveyStepIndex(getInitialSurveyStepIndex(currentUser.survey));
    setSurveyMode(hasSurveyData(currentUser.survey) ? "questions" : "intro");
    setShowSurveyCompletionScreen(false);
  }, [currentUser?.id]);

  const syncCurrentUser = (transform: (user: UserRecord) => UserRecord) => {
    void updatePersistedState((current) => {
      if (!current.currentUserId) {
        return current;
      }

      return {
        ...current,
        accounts: current.accounts.map((account) =>
          account.id === current.currentUserId ? transform(account) : account
        ),
      };
    });
  };

  const handleRegistration = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError(null);

    const fullName =
      registerForm.fullName.trim() || buildVKName(vkUser) || "Александр Петров";
    const email = normalizeEmail(registerForm.email);

    if (!fullName || !email || !registerForm.password || !registerForm.confirmPassword) {
      setAuthError("Заполните все поля регистрации.");
      return;
    }

    if (registerForm.password !== registerForm.confirmPassword) {
      setAuthError("Пароли не совпадают.");
      return;
    }

    if (isBackendConfigured()) {
      try {
        const backendState = await registerBackendUser({
          fullName,
          email,
          password: registerForm.password,
          survey: surveyDraft,
          onboardingComplete: isSurveyComplete(surveyDraft),
        });

        if (backendState) {
          await commitState(backendState, { awaitRemote: false });
          setRegisterForm({
            fullName: buildVKName(vkUser) ?? "",
            email: "",
            password: "",
            confirmPassword: "",
          });
          setSurveyMode("complete");
          setSurveyStepIndex(surveyQuestions.length);
          setShowSurveyCompletionScreen(isSurveyComplete(surveyDraft));
          return;
        }
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "Не удалось зарегистрироваться.");
        return;
      }
    }

    const syncedState = await syncStateFromRemote();

    if (syncedState.accounts.some((account) => normalizeEmail(account.email) === email)) {
      setAuthError("Аккаунт с такой почтой уже существует.");
      return;
    }

    const user: UserRecord = {
      id: crypto.randomUUID(),
      vkId: vkUser?.id ? String(vkUser.id) : undefined,
      fullName,
      email,
      password: registerForm.password,
      region: "Москва",
      createdAt: new Date().toISOString(),
      survey: surveyDraft,
      onboardingComplete: isSurveyComplete(surveyDraft),
      favorites: [],
      metrics: [],
    };

    await commitState(
      {
        accounts: [...syncedState.accounts, user],
        currentUserId: user.id,
      },
      {
        awaitRemote: true,
      }
    );
    setRegisterForm({
      fullName: buildVKName(vkUser) ?? "",
      email: "",
      password: "",
      confirmPassword: "",
    });
    setSurveyMode("complete");
    setSurveyStepIndex(surveyQuestions.length);
    setShowSurveyCompletionScreen(isSurveyComplete(surveyDraft));
  };

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError(null);

    if (isBackendConfigured()) {
      try {
        const backendState = await loginBackendUser(loginForm.email, loginForm.password);

        if (backendState) {
          await commitState(backendState, { awaitRemote: false });
          setLoginForm({ email: "", password: "" });
          setSurveyError(null);
          setShowSurveyCompletionScreen(false);
          return;
        }
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "Не удалось войти.");
        return;
      }
    }

    const syncedState = await syncStateFromRemote();
    const normalizedEmail = normalizeEmail(loginForm.email);
    const account = syncedState.accounts.find(
      (item) => normalizeEmail(item.email) === normalizedEmail
    );

    if (!account || account.password !== loginForm.password) {
      setAuthError("Неверная почта или пароль.");
      return;
    }

    const vkId = vkUser?.id ? String(vkUser.id) : undefined;
    const updatedAccounts = syncedState.accounts.map((item) =>
      item.id === account.id
        ? {
            ...item,
            vkId: vkId && item.vkId !== vkId ? vkId : item.vkId,
          }
        : item
    );

    await commitState(
      {
        ...syncedState,
        accounts: updatedAccounts,
        currentUserId: account.id,
      },
      {
        awaitRemote: true,
      }
    );
    setLoginForm({ email: "", password: "" });
    setSurveyError(null);
    setShowSurveyCompletionScreen(false);
  };

  const updateSurveyDraft = (
    key: keyof SurveyAnswers,
    value: SurveyAnswers[keyof SurveyAnswers]
  ) => {
    const nextSurvey = { ...surveyDraft, [key]: value };
    setSurveyDraft(nextSurvey);
    setSurveyError(null);

    if (currentUser) {
      syncCurrentUser((user) => ({
        ...user,
        survey: nextSurvey,
      }));
    }
  };

  const toggleSurveyDraftValue = (key: "excludedProducts", option: string) => {
    const currentValues = Array.isArray(surveyDraft[key]) ? surveyDraft[key] : [];
    const nextValues = currentValues.includes(option)
      ? currentValues.filter((value) => value !== option)
      : [...currentValues, option];

    updateSurveyDraft(key, nextValues);
  };

  const toggleOptionalChoiceValue = (key: "personalRestrictions", value: string) => {
    updateSurveyDraft(key, surveyDraft[key] === value ? undefined : value);
  };

  const handleSurveyContinue = () => {
    const question = surveyQuestions[surveyStepIndex];

    if (!question) {
      return;
    }

    const answer = surveyDraft[question.key];

    if (question.kind === "number") {
      if (!answer || Number(answer) < MIN_SURVEY_AGE || Number(answer) > MAX_SURVEY_AGE) {
        setSurveyError(`Возраст должен быть от ${MIN_SURVEY_AGE} до ${MAX_SURVEY_AGE} лет.`);
        return;
      }
    } else if (question.kind === "choice" && !answer) {
      setSurveyError("Выберите один из вариантов.");
      return;
    }

    setSurveyError(null);

    if (surveyStepIndex === surveyQuestions.length - 1) {
      syncCurrentUser((user) => ({
        ...user,
        survey: surveyDraft,
        onboardingComplete: true,
      }));
      setSurveyMode("complete");
      setShowSurveyCompletionScreen(true);
      return;
    }

    setSurveyStepIndex((current) => current + 1);
  };

  const handlePreRegistrationSurveyContinue = () => {
    const question = surveyQuestions[surveyStepIndex];

    if (!question) {
      return;
    }

    const answer = surveyDraft[question.key];

    if (question.kind === "number") {
      if (!answer || Number(answer) < MIN_SURVEY_AGE || Number(answer) > MAX_SURVEY_AGE) {
        setSurveyError(`Возраст должен быть от ${MIN_SURVEY_AGE} до ${MAX_SURVEY_AGE} лет.`);
        return;
      }
    } else if (question.kind === "choice" && !answer) {
      setSurveyError("Выберите один из вариантов.");
      return;
    }

    setSurveyError(null);

    if (surveyStepIndex === surveyQuestions.length - 1) {
      setAuthView("register");
      setSurveyMode("complete");
      return;
    }

    setSurveyStepIndex((current) => current + 1);
    setSurveyMode("questions");
  };

  const handlePreRegistrationSurveyBack = () => {
    if (surveyStepIndex === 0) {
      setSurveyMode("intro");
      return;
    }

    setSurveyStepIndex((current) => Math.max(current - 1, 0));
    setSurveyError(null);
  };

  const handleSurveyBack = () => {
    if (surveyStepIndex === 0) {
      setSurveyMode("intro");
      return;
    }

    setSurveyStepIndex((current) => Math.max(current - 1, 0));
    setSurveyError(null);
  };

  const toggleFavorite = (recipeId: string) => {
    syncCurrentUser((user) => {
      const nextFavorites = user.favorites.includes(recipeId)
        ? user.favorites.filter((id) => id !== recipeId)
        : [...user.favorites, recipeId];

      return {
        ...user,
        favorites: nextFavorites,
      };
    });
  };

  const handleSaveMetric = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMetricError(null);

    const numericValue = Number(metricDraft.value.replace(",", "."));

    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      setMetricError("Введите корректное значение.");
      return;
    }

    const nextMetric: MetricEntry = {
      id: crypto.randomUUID(),
      type: metricDraft.type,
      value: metricDraft.type === "steps" ? Math.round(numericValue) : Number(numericValue.toFixed(1)),
      unit: metricUnits[metricDraft.type],
      note:
        metricDraft.note.trim() ||
        (metricDraft.type === "glucose"
          ? "Новая запись сахара"
          : metricDraft.type === "weight"
            ? "Контроль веса"
            : "Ежедневная активность"),
      timestamp: new Date().toISOString(),
    };

    syncCurrentUser((user) => ({
      ...user,
      metrics: [nextMetric, ...user.metrics].sort(
        (left, right) =>
          new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime()
      ),
    }));
    setMetricDraft({
      type: metricDraft.type,
      value: "",
      note: "",
    });
    setMetricFormOpen(false);
  };

  const handleSaveProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!profileDraft.fullName.trim()) {
      return;
    }

    syncCurrentUser((user) => ({
      ...user,
      fullName: profileDraft.fullName.trim(),
      region: profileDraft.region.trim() || user.region,
    }));
    setProfileEditorOpen(false);
  };

  const handleLogout = () => {
    void logoutBackend();
    void updatePersistedState(
      (current) => ({
        ...current,
        currentUserId: null,
      }),
      {
        awaitRemote: true,
      }
    );
    setAuthView("launch");
    setLoginForm({ email: "", password: "" });
    setAuthError(null);
    setSurveyDraft({});
    setSurveyMode("intro");
    setSurveyStepIndex(0);
    setSurveyError(null);
    setShowSurveyCompletionScreen(false);
  };

  let content: ReactNode;

  if (!currentUser) {
    if (!storageHydrated) {
      content = <StorageLoadingScreen />;
    } else if (authView === "launch") {
      content = (
        <LaunchScreen
          onLogin={() => {
            setAuthError(null);
            setAuthView("login");
          }}
          onRegister={() => {
            setAuthError(null);
            setSurveyDraft({});
            setSurveyStepIndex(0);
            setSurveyMode("intro");
            setSurveyError(null);
            setAuthView("preSurvey");
          }}
        />
      );
    } else if (authView === "preSurvey") {
      const currentQuestion = surveyQuestions[surveyStepIndex];

      if (surveyMode === "intro") {
        content = (
          <SurveyIntro
            onContinue={() => setSurveyMode("questions")}
            onBack={() => {
              setSurveyDraft({});
              setSurveyStepIndex(0);
              setSurveyError(null);
              setAuthView("launch");
            }}
          />
        );
      } else if (currentQuestion.kind === "choice") {
        const selectedValue = surveyDraft[currentQuestion.key];

        content = (
          <SurveyQuestionScreen
            title={currentQuestion.title}
            description={currentQuestion.description}
            onBack={handlePreRegistrationSurveyBack}
            error={surveyError}
            footer={
              <Button variant="dark" onClick={handlePreRegistrationSurveyContinue}>
                Подтвердить
              </Button>
            }
          >
            <div className="option-list">
              {currentQuestion.options.map((option) => (
                <OptionCard
                  key={option}
                  selected={selectedValue === option}
                  label={option}
                  onClick={() => updateSurveyDraft(currentQuestion.key, option)}
                />
              ))}
            </div>
          </SurveyQuestionScreen>
        );
      } else if (currentQuestion.kind === "nutrition") {
        const selectedProducts: string[] = Array.isArray(surveyDraft[currentQuestion.key])
          ? (surveyDraft[currentQuestion.key] as string[])
          : [];
        const selectedRestriction =
          typeof surveyDraft[currentQuestion.secondaryKey] === "string"
            ? surveyDraft[currentQuestion.secondaryKey]
            : undefined;

        content = (
          <SurveyQuestionScreen
            title={currentQuestion.title}
            description={currentQuestion.description}
            onBack={handlePreRegistrationSurveyBack}
            error={surveyError}
            footer={
              <Button variant="dark" onClick={handlePreRegistrationSurveyContinue}>
                Подтвердить
              </Button>
            }
          >
            <div className="survey-stack">
              <div className="survey-tag-list">
                {currentQuestion.options.map((option) => (
                  <button
                    key={option}
                    className={classNames(
                      "survey-tag",
                      selectedProducts.includes(option) && "is-selected"
                    )}
                    onClick={() => toggleSurveyDraftValue("excludedProducts", option)}
                    type="button"
                  >
                    {option}
                  </button>
                ))}
              </div>

              <div className="survey-stack survey-stack--section">
                <h2 className="survey-section-title">{currentQuestion.secondaryTitle}</h2>
                <div className="option-list option-list--compact">
                  {currentQuestion.secondaryOptions.map((option) => (
                    <OptionCard
                      key={option}
                      selected={selectedRestriction === option}
                      label={option}
                      onClick={() => toggleOptionalChoiceValue("personalRestrictions", option)}
                    />
                  ))}
                </div>
              </div>
            </div>
          </SurveyQuestionScreen>
        );
      } else {
        content = (
          <SurveyQuestionScreen
            title={currentQuestion.title}
            description={currentQuestion.description}
            onBack={handlePreRegistrationSurveyBack}
            error={surveyError}
            footer={
              <Button variant="dark" onClick={handlePreRegistrationSurveyContinue}>
                Подтвердить
              </Button>
            }
          >
            <Field
              className="field--survey-number"
              label=""
              placeholder={currentQuestion.placeholder}
              value={surveyDraft.age ? String(surveyDraft.age) : ""}
              onChange={(event) => {
                const digits = event.target.value.replace(/\D/g, "");
                updateSurveyDraft("age", digits ? Number(digits) : undefined);
              }}
              type="number"
              inputMode="numeric"
              min={MIN_SURVEY_AGE}
              max={MAX_SURVEY_AGE}
            />
          </SurveyQuestionScreen>
        );
      }
    } else if (authView === "login") {
      content = (
        <AuthScreen
          title="Авторизация"
          subtitle="Ваш надежный партнер в питании"
          error={authError}
          onBack={() => {
            setAuthError(null);
            setAuthView("launch");
          }}
          onSubmit={handleLogin}
          actionLabel="Войти"
          footerLabel="Нет аккаунта?"
          footerAction="Я здесь впервые"
          onFooterClick={() => {
            setAuthError(null);
            setSurveyDraft({});
            setSurveyStepIndex(0);
            setSurveyMode("intro");
            setSurveyError(null);
            setAuthView("preSurvey");
          }}
        >
          <Field
            label="Ваша почта"
            placeholder="Введите email"
            value={loginForm.email}
            onChange={(event) =>
              setLoginForm((current) => ({ ...current, email: event.target.value }))
            }
            icon={<MailIcon />}
            autoComplete="email"
          />
          <Field
            label="Введите пароль"
            placeholder="Пароль"
            type="password"
            value={loginForm.password}
            onChange={(event) =>
              setLoginForm((current) => ({ ...current, password: event.target.value }))
            }
            icon={<LockIcon />}
            autoComplete="current-password"
          />
        </AuthScreen>
      );
    } else {
      content = (
        <AuthScreen
          title="Регистрация"
          subtitle="Создайте профиль и получите персональные рекомендации"
          error={authError}
          onBack={() => {
            setAuthError(null);
            setAuthView("preSurvey");
            setSurveyMode("questions");
            setSurveyStepIndex(surveyQuestions.length - 1);
          }}
          onSubmit={handleRegistration}
          actionLabel="Завершить регистрацию"
          footerLabel="Уже зарегистрированы?"
          footerAction="Войти"
          onFooterClick={() => {
            setAuthError(null);
            setAuthView("login");
          }}
        >
          <Field
            label="Ваше имя"
            placeholder="Введите имя"
            value={registerForm.fullName}
            onChange={(event) =>
              setRegisterForm((current) => ({ ...current, fullName: event.target.value }))
            }
            icon={<UserIcon />}
            autoComplete="name"
          />
          <Field
            label="Ваша почта"
            placeholder="Введите email"
            value={registerForm.email}
            onChange={(event) =>
              setRegisterForm((current) => ({ ...current, email: event.target.value }))
            }
            icon={<MailIcon />}
            autoComplete="email"
          />
          <Field
            label="Придумайте пароль"
            placeholder="Минимум 6 символов"
            type="password"
            value={registerForm.password}
            onChange={(event) =>
              setRegisterForm((current) => ({ ...current, password: event.target.value }))
            }
            icon={<LockIcon />}
            autoComplete="new-password"
          />
          <Field
            label="Подтвердите пароль"
            placeholder="Повторите пароль"
            type="password"
            value={registerForm.confirmPassword}
            onChange={(event) =>
              setRegisterForm((current) => ({
                ...current,
                confirmPassword: event.target.value,
              }))
            }
            icon={<LockIcon />}
            autoComplete="new-password"
          />
        </AuthScreen>
      );
    }
  } else if (showSurveyCompletionScreen) {
    content = (
      <SurveyDone
        onStart={() => {
          setShowSurveyCompletionScreen(false);
          setActiveTab("home");
        }}
      />
    );
  } else if (!currentUserOnboardingComplete) {
    const currentQuestion = surveyQuestions[surveyStepIndex];

    if (surveyMode === "intro") {
      content = (
        <SurveyIntro
          name={getFirstName(currentUser.fullName)}
          onContinue={() => setSurveyMode("questions")}
          onBack={handleLogout}
        />
      );
    } else if (currentQuestion.kind === "choice") {
      const selectedValue = surveyDraft[currentQuestion.key];

      content = (
        <SurveyQuestionScreen
          title={currentQuestion.title}
          description={currentQuestion.description}
          onBack={handleSurveyBack}
          error={surveyError}
          footer={
            <Button variant="dark" onClick={handleSurveyContinue}>
              Подтвердить
            </Button>
          }
        >
          <div className="option-list">
            {currentQuestion.options.map((option) => (
              <OptionCard
                key={option}
                selected={selectedValue === option}
                label={option}
                onClick={() => updateSurveyDraft(currentQuestion.key, option)}
              />
            ))}
          </div>
        </SurveyQuestionScreen>
      );
    } else if (currentQuestion.kind === "nutrition") {
      const selectedProducts: string[] = Array.isArray(surveyDraft[currentQuestion.key])
        ? (surveyDraft[currentQuestion.key] as string[])
        : [];
      const selectedRestriction =
        typeof surveyDraft[currentQuestion.secondaryKey] === "string"
          ? surveyDraft[currentQuestion.secondaryKey]
          : undefined;

      content = (
        <SurveyQuestionScreen
          title={currentQuestion.title}
          description={currentQuestion.description}
          onBack={handleSurveyBack}
          error={surveyError}
          footer={
            <Button variant="dark" onClick={handleSurveyContinue}>
              Подтвердить
            </Button>
          }
        >
          <div className="survey-stack">
            <div className="survey-tag-list">
              {currentQuestion.options.map((option) => (
                <button
                  key={option}
                  className={classNames(
                    "survey-tag",
                    selectedProducts.includes(option) && "is-selected"
                  )}
                  onClick={() => toggleSurveyDraftValue("excludedProducts", option)}
                  type="button"
                >
                  {option}
                </button>
              ))}
            </div>

            <div className="survey-stack survey-stack--section">
              <h2 className="survey-section-title">{currentQuestion.secondaryTitle}</h2>
              <div className="option-list option-list--compact">
                {currentQuestion.secondaryOptions.map((option) => (
                  <OptionCard
                    key={option}
                    selected={selectedRestriction === option}
                    label={option}
                    onClick={() => toggleOptionalChoiceValue("personalRestrictions", option)}
                  />
                ))}
              </div>
            </div>
          </div>
        </SurveyQuestionScreen>
      );
    } else {
      content = (
        <SurveyQuestionScreen
          title={currentQuestion.title}
          description={currentQuestion.description}
          onBack={handleSurveyBack}
          error={surveyError}
          footer={
            <Button variant="dark" onClick={handleSurveyContinue}>
              Подтвердить
            </Button>
          }
        >
          <Field
            className="field--survey-number"
            label=""
            placeholder={currentQuestion.placeholder}
            value={surveyDraft.age ? String(surveyDraft.age) : ""}
            onChange={(event) => {
              const digits = event.target.value.replace(/\D/g, "");
              updateSurveyDraft("age", digits ? Number(digits) : undefined);
            }}
            type="number"
            inputMode="numeric"
            min={MIN_SURVEY_AGE}
            max={MAX_SURVEY_AGE}
          />
        </SurveyQuestionScreen>
      );
    }
  } else if (selectedRecipe) {
    content = (
      <div className="app-layout">
        <div className="screen-content screen-content--detail">
          <DetailLayout onBack={() => setSelectedRecipeId(null)} title="Ваш рецепт">
            <RecipePreviewCard
              recipe={selectedRecipe}
              isFavorite={favoriteIds.has(selectedRecipe.id)}
              compact={false}
              onToggleFavorite={() => toggleFavorite(selectedRecipe.id)}
              onOpen={() => undefined}
            />

            <section className="detail-section">
              <p className="recipe-eyebrow">{selectedRecipe.tags.join(" • ")}</p>
              <h2>{selectedRecipe.title}</h2>
              <p className="detail-copy">{selectedRecipe.description}</p>
              <p className="detail-copy">
                ГИ: {selectedRecipe.gi} • ХЕ: {selectedRecipe.xe}
              </p>
              <p className="detail-copy">
                КБЖУ: {selectedRecipe.calories} ккал, {selectedRecipe.carbs} г углеводов,{" "}
                {selectedRecipe.protein} г белков, {selectedRecipe.fat} г жиров
              </p>
            </section>

            <section className="detail-section">
              <h3>Ингредиенты</h3>
              <ul className="detail-list">
                {selectedRecipe.ingredients.map((ingredient) => (
                  <li key={ingredient}>{ingredient}</li>
                ))}
              </ul>
            </section>

            <section className="detail-section">
              <h3>Приготовление</h3>
              <ol className="detail-list detail-list--ordered">
                {selectedRecipe.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </section>
          </DetailLayout>
        </div>

        <BottomNavigation
          activeTab={activeTab}
          onChange={(tab) =>
            startTransition(() => {
              setActiveTab(tab);
              setSelectedArticleId(null);
              setSelectedRecipeId(null);
            })
          }
        />
      </div>
    );
  } else if (selectedArticle) {
    content = (
      <div className="app-layout">
        <div className="screen-content screen-content--detail">
          <DetailLayout onBack={() => setSelectedArticleId(null)} title="Новости">
            <article className="article-detail">
              <span className="article-label">{selectedArticle.label}</span>
              <h2>{selectedArticle.title}</h2>
              <p className="article-highlight">{selectedArticle.highlight}</p>
              {selectedArticle.body.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </article>
          </DetailLayout>
        </div>

        <BottomNavigation
          activeTab={activeTab}
          onChange={(tab) =>
            startTransition(() => {
              setActiveTab(tab);
              setSelectedArticleId(null);
              setSelectedRecipeId(null);
            })
          }
        />
      </div>
    );
  } else {
    content = (
      <div className="app-layout">
        <div className="screen-content">
          {activeTab === "home" ? (
            <>
              <header className="screen-header">
                <div>
                  <p className="eyebrow">ВАШ ПЕРСОНАЛЬНЫЙ ХАБ</p>
                  <h1 className="screen-title">
                    Доброе {getGreetingWord()},<br />
                    {greetingName}
                  </h1>
                </div>
                <Avatar name={greetingName} photo={vkUser?.photo_200} />
              </header>

              <label className="search-field">
                <SearchIcon />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Введите для поиска..."
                />
              </label>

              <div className="section-switcher">
                <button
                  className={classNames(
                    "section-switcher__item",
                    homeSection === "recommended" && "is-active"
                  )}
                  onClick={() => setHomeSection("recommended")}
                  type="button"
                >
                  Рекомендовано
                </button>
                <button
                  className={classNames(
                    "section-switcher__item",
                    homeSection === "favorites" && "is-active"
                  )}
                  onClick={() => setHomeSection("favorites")}
                  type="button"
                >
                  Избранное
                </button>
              </div>

              {heroRecipe ? (
                <>
                  <section className="hero-recipe-section">
                    <SectionHeading
                      title={
                        homeSection === "favorites"
                          ? "Избранные рецепты"
                          : "Сегодня для вас"
                      }
                      subtitle={
                        homeSection === "favorites"
                          ? favoritesCount
                            ? `У вас ${formatSavedRecipes(favoritesCount)}.`
                            : "Сохраняйте блюда сердечком, и они появятся в личной подборке."
                          : heroRecipe.focus
                      }
                    />
                    <RecipePreviewCard
                      recipe={heroRecipe}
                      isFavorite={favoriteIds.has(heroRecipe.id)}
                      compact={false}
                      onToggleFavorite={() => toggleFavorite(heroRecipe.id)}
                      onOpen={() =>
                        startTransition(() => {
                          setSelectedRecipeId(heroRecipe.id);
                        })
                      }
                    />
                  </section>

                  {homeSection === "recommended" ? (
                    <>
                      <section className="catalog-section">
                        <SectionHeading
                          title="Все рецепты"
                          subtitle="Полный список блюд сразу под вашей персональной рекомендацией"
                        />
                        <div className="chip-row chip-row--after-hero catalog-tabs" role="tablist">
                          {recipeCatalogTabs.map((tab) => (
                            <button
                              key={tab}
                              type="button"
                              role="tab"
                              aria-selected={recipeCatalogTab === tab}
                              className={classNames(
                                "filter-chip",
                                recipeCatalogTab === tab && "is-active"
                              )}
                              onClick={() => setRecipeCatalogTab(tab)}
                            >
                              {tab}
                            </button>
                          ))}
                        </div>
                        {catalogRecipes.length ? (
                          <section className="recipe-grid">
                            {catalogRecipes.map((recipe) => (
                              <RecipePreviewCard
                                key={recipe.id}
                                recipe={recipe}
                                isFavorite={favoriteIds.has(recipe.id)}
                                compact
                                onToggleFavorite={() => toggleFavorite(recipe.id)}
                                onOpen={() =>
                                  startTransition(() => {
                                    setSelectedRecipeId(recipe.id);
                                  })
                                }
                              />
                            ))}
                          </section>
                        ) : (
                          <EmptyState
                            title="В этой вкладке пока пусто."
                            description="Переключите вкладку или очистите поиск, чтобы увидеть другие рецепты."
                          />
                        )}
                      </section>
                    </>
                  ) : catalogRecipes.length ? (
                    <section className="catalog-section">
                      <SectionHeading
                        title="Остальные избранные"
                        subtitle="Сохраненные рецепты, которые всегда под рукой"
                      />
                      <section className="recipe-grid">
                        {catalogRecipes.map((recipe) => (
                          <RecipePreviewCard
                            key={recipe.id}
                            recipe={recipe}
                            isFavorite={favoriteIds.has(recipe.id)}
                            compact
                            onToggleFavorite={() => toggleFavorite(recipe.id)}
                            onOpen={() =>
                              startTransition(() => {
                                setSelectedRecipeId(recipe.id);
                              })
                            }
                          />
                        ))}
                      </section>
                    </section>
                  ) : null}
                </>
              ) : (
                <EmptyState
                  title={
                    homeSection === "favorites"
                      ? "В избранном пока пусто."
                      : "По вашему запросу пока ничего не найдено."
                  }
                  description={
                    homeSection === "favorites"
                      ? "Сохраняйте рецепты сердечком, и они будут всегда под рукой."
                      : "Попробуйте изменить запрос или очистить поиск, чтобы увидеть все рецепты."
                  }
                />
              )}
            </>
          ) : null}

          {activeTab === "feed" ? (
            <>
              <section className="feed-hero">
                <div className="feed-hero__badge">НОВОСТИ</div>
                <p>Свежие новости и полезные обновления без лишних разделов.</p>
              </section>

              <div className="article-list">
                {articles.map((article) => (
                  <button
                    key={article.id}
                    className="article-card"
                    onClick={() =>
                      startTransition(() => {
                        setSelectedArticleId(article.id);
                      })
                    }
                    type="button"
                  >
                    <span className="article-label">{article.label}</span>
                    <h3>{article.title}</h3>
                    <p>{article.excerpt}</p>
                    <div className="article-card__footer">
                  <span>{formatReadMinutes(article.readMinutes)} чтения</span>
                      <ChevronRightIcon />
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {activeTab === "metrics" ? (
            <>
              <header className="screen-header screen-header--compact">
                <div>
                  <h1 className="screen-title">Метрики</h1>
                  <p className="screen-subtitle">{formatLongDate(new Date().toISOString())}</p>
                </div>
                <Button
                  variant="soft"
                  className="metrics-add-button"
                  onClick={() => setMetricFormOpen(true)}
                >
                  <PlusIcon />
                  Запись
                </Button>
              </header>

              <div className="metrics-highlight-grid">
                <article className="metric-highlight metric-highlight--soft">
                  <span>сегодня</span>
                  <strong>{glucoseStatus}</strong>
                </article>
                <article className="metric-highlight metric-highlight--strong">
                  <span>средний сахар</span>
                  <strong>{hasGlucoseData ? averageGlucose.toFixed(1) : "—"}</strong>
                  <em>{hasGlucoseData ? "ммоль/л" : "Добавьте запись"}</em>
                </article>
              </div>

              <section className="metrics-chart-card">
                <div className="section-heading section-heading--row">
                  <div>
                    <h2>Глюкоза крови</h2>
                  </div>
                  <div className="range-switch">
                    <button
                      className={classNames(metricsRange === "7d" && "is-active")}
                      onClick={() => setMetricsRange("7d")}
                      type="button"
                    >
                      7 дней
                    </button>
                    <button
                      className={classNames(metricsRange === "30d" && "is-active")}
                      onClick={() => setMetricsRange("30d")}
                      type="button"
                    >
                      30 дней
                    </button>
                  </div>
                </div>

                {hasGlucoseData ? (
                  <div className={classNames("metrics-chart", metricsRange === "30d" && "metrics-chart--30d")}>
                    {chartPoints.map((point, index) => {
                      const showLabel =
                        metricsRange === "7d" ||
                        index === 0 ||
                        index === chartPoints.length - 1 ||
                        index % 5 === 4;

                      return (
                        <div key={`${point.label}-${index}`} className="metrics-chart__item">
                          <div className="metrics-chart__bar-track">
                            <div
                              className={classNames(
                                "metrics-chart__bar",
                                point.isAccent && "is-accent"
                              )}
                              style={{ height: `${point.height}%` }}
                            />
                          </div>
                          <span className={classNames("metrics-chart__label", !showLabel && "is-hidden")}>
                            {showLabel ? point.label : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState
                    title="Пока нет записей глюкозы."
                    description="Добавьте первый показатель, и здесь появится динамика."
                  />
                )}
              </section>

              <div className="stats-card-grid">
                <article className="stats-card">
                  <div className="stats-card__icon">
                    <ScaleIcon />
                  </div>
                  <span>Вес</span>
                  <strong>{latestWeight ? `${latestWeight.value.toFixed(1)} кг` : "—"}</strong>
                  <p>
                    {latestWeight && previousWeight
                      ? `${formatSigned(latestWeight.value - previousWeight.value)} кг за период`
                      : "Добавьте первую запись веса"}
                  </p>
                </article>

                <article className="stats-card">
                  <div className="stats-card__icon stats-card__icon--warm">
                    <ActivityIcon />
                  </div>
                  <span>Активность</span>
                  <strong>{latestSteps ? `${Math.round(latestSteps.value)}` : "—"}</strong>
                  <p>
                    {latestSteps
                      ? `${getRussianPlural(Math.round(latestSteps.value), ["шаг", "шага", "шагов"])} за день`
                      : "Добавьте запись активности"}
                  </p>
                  <div className="progress-line">
                    <div
                      style={{
                        width: `${Math.min(
                          100,
                          ((latestSteps?.value ?? 0) / 10000) * 100
                        )}%`,
                      }}
                    />
                  </div>
                </article>
              </div>

              <section className="metric-log">
                <SectionHeading
                  title="Последние записи"
                  subtitle="Все свежие показатели пользователя"
                />
                {hasMetricData ? (
                  <div className="metric-log__list">
                    {(currentUser.metrics ?? []).slice(0, 6).map((entry) => (
                      <article
                        key={entry.id}
                        className={classNames("metric-log__item", `metric-log__item--${entry.type}`)}
                      >
                        <div className="metric-log__content">
                          <strong>{metricEntryTitle(entry)}</strong>
                          <span>
                            {formatMetricDate(entry.timestamp)}, {formatMetricTime(entry.timestamp)}
                          </span>
                          <span className="metric-log__note">{entry.note}</span>
                        </div>
                        <strong className="metric-log__value">
                          {formatMetricValue(entry)}
                        </strong>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="Последних записей пока нет."
                    description="Когда вы добавите показатель, он появится в этом списке."
                  />
                )}
              </section>
            </>
          ) : null}

          {activeTab === "profile" ? (
            <>
              <header className="profile-hero">
                <div className="profile-hero__identity">
                  <Avatar name={currentUser.fullName} photo={vkUser?.photo_200} large />
                  <div>
                    <span className="premium-pill">ПРЕМИУМ СТАТУС</span>
                    <h1>{currentUser.fullName}</h1>
                  </div>
                </div>

                <div className="profile-meta">
                  <article>
                    <span>ID пациента</span>
                    <strong>{buildPatientId(currentUser.id)}</strong>
                  </article>
                  <article>
                    <span>Регион</span>
                    <strong>{currentUser.region}</strong>
                  </article>
                </div>
              </header>

              <section className="profile-settings">
                <p className="profile-section-label">Настройки и предпочтения</p>
                <div className="profile-card-list">
                <button
                  className="profile-card"
                  onClick={() => setProfileEditorOpen(true)}
                  type="button"
                >
                  <div className="profile-card__icon">
                    <ProfileDataIcon />
                  </div>
                  <div>
                    <strong>Личные данные</strong>
                    <span>Профиль, контакты, регион</span>
                  </div>
                  <ChevronRightIcon />
                </button>
                <button className="profile-card" type="button">
                  <div className="profile-card__icon">
                    <SavedIcon />
                  </div>
                  <div>
                    <strong>Избранное</strong>
                    <span>{formatSavedRecipes(favoritesCount)}</span>
                  </div>
                  <ChevronRightIcon />
                </button>
                <button className="profile-card" type="button">
                  <div className="profile-card__icon">
                    <StatsIcon />
                  </div>
                  <div>
                    <strong>Настройки здоровья</strong>
                    <span>Цели, параметры, устройства</span>
                  </div>
                  <ChevronRightIcon />
                </button>
                <button className="profile-card" type="button">
                  <div className="profile-card__icon">
                    <NotificationsIcon />
                  </div>
                  <div>
                    <strong>Уведомления</strong>
                    <span>Пуши, email, напоминания</span>
                  </div>
                  <ChevronRightIcon />
                </button>
                </div>
              </section>

              <section className="health-summary">
                <SectionHeading
                  title="Профиль здоровья"
                  subtitle="Краткая сводка по анкете"
                />
                <div className="health-summary__grid">
                  <SummaryTile label="Тип диабета" value={currentUser.survey.diabetesType ?? "—"} />
                  <SummaryTile label="Терапия" value={shortenTherapy(currentUser.survey.therapy)} />
                  <SummaryTile
                    label="Возраст"
                    value={currentUser.survey.age ? formatAge(currentUser.survey.age) : "—"}
                  />
                  <SummaryTile
                    label="Гипогликемии"
                    value={currentUser.survey.hypoglycemia ?? "—"}
                  />
                </div>
              </section>

              <Button variant="ghost-danger" onClick={handleLogout}>
                Выйти из аккаунта
              </Button>
            </>
          ) : null}
        </div>

        <BottomNavigation
          activeTab={activeTab}
          onChange={(tab) =>
            startTransition(() => {
              setActiveTab(tab);
              setSelectedArticleId(null);
              setSelectedRecipeId(null);
            })
          }
        />

        {metricFormOpen ? (
          <ModalSurface title="Новая запись" onClose={() => setMetricFormOpen(false)}>
            <form className="modal-form" onSubmit={handleSaveMetric}>
              <div className="segmented-control">
                {(["glucose", "weight", "steps"] as MetricType[]).map((type) => (
                  <button
                    key={type}
                    className={classNames(
                      "segmented-control__item",
                      metricDraft.type === type && "is-active"
                    )}
                    onClick={() =>
                      setMetricDraft((current) => ({
                        ...current,
                        type,
                      }))
                    }
                    type="button"
                  >
                    {type === "glucose"
                      ? "Сахар"
                      : type === "weight"
                        ? "Вес"
                        : "Шаги"}
                  </button>
                ))}
              </div>
              <Field
                label="Значение"
                placeholder={metricPlaceholders[metricDraft.type]}
                value={metricDraft.value}
                onChange={(event) =>
                  setMetricDraft((current) => ({ ...current, value: event.target.value }))
                }
                inputMode={metricDraft.type === "steps" ? "numeric" : "decimal"}
              />
              <Field
                label="Комментарий"
                placeholder="Например, после обеда"
                value={metricDraft.note}
                onChange={(event) =>
                  setMetricDraft((current) => ({ ...current, note: event.target.value }))
                }
              />
              {metricError ? <p className="form-error">{metricError}</p> : null}
              <Button type="submit">Сохранить</Button>
            </form>
          </ModalSurface>
        ) : null}

        {profileEditorOpen ? (
          <ModalSurface title="Личные данные" onClose={() => setProfileEditorOpen(false)}>
            <form className="modal-form" onSubmit={handleSaveProfile}>
              <Field
                className="field--profile"
                label="Ваше имя"
                placeholder="Имя и фамилия"
                value={profileDraft.fullName}
                onChange={(event) =>
                  setProfileDraft((current) => ({ ...current, fullName: event.target.value }))
                }
              />
              <Field
                className="field--profile"
                label="Регион"
                placeholder="Например, Москва"
                value={profileDraft.region}
                onChange={(event) =>
                  setProfileDraft((current) => ({ ...current, region: event.target.value }))
                }
              />
              <Button type="submit">Сохранить</Button>
            </form>
          </ModalSurface>
        ) : null}
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="app-frame">
        <div className="screen-transition">
          {content}
        </div>
      </div>
    </div>
  );
}

function StorageLoadingScreen() {
  return (
    <section className="launch-screen launch-screen--loading">
      <div className="launch-screen__content">
        <BrandLogo />
        <h1>МЕРИДИАН</h1>
        <p>Восстанавливаем ваш профиль и вход...</p>
      </div>
    </section>
  );
}

function LaunchScreen({
  onLogin,
  onRegister,
}: {
  onLogin: () => void;
  onRegister: () => void;
}) {
  return (
    <section className="launch-screen">
      <div className="launch-screen__content">
        <BrandLogo />
        <h1>МЕРИДИАН</h1>
        <p>Ваш надежный партнер в питании</p>
      </div>

      <div className="stack-actions">
        <Button onClick={onLogin}>Войти</Button>
        <Button variant="soft" onClick={onRegister}>
          Я здесь впервые
        </Button>
      </div>
    </section>
  );
}

function AuthScreen({
  title,
  subtitle,
  children,
  error,
  actionLabel,
  footerLabel,
  footerAction,
  onBack,
  onSubmit,
  onFooterClick,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  error: string | null;
  actionLabel: string;
  footerLabel: string;
  footerAction: string;
  onBack: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onFooterClick: () => void;
}) {
  return (
    <section className="auth-screen">
      <div className="auth-screen__hero">
        <button
          className="round-back auth-back-button"
          onClick={onBack}
          type="button"
          aria-label="Назад"
        >
          <ArrowLeftIcon />
        </button>
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
      </div>

      <form className="auth-card" onSubmit={onSubmit}>
        {children}
        {error ? <p className="form-error">{error}</p> : null}
        <Button type="submit">{actionLabel}</Button>
        <p className="auth-footer">
          {footerLabel}{" "}
          <button type="button" onClick={onFooterClick}>
            {footerAction}
          </button>
        </p>
      </form>
    </section>
  );
}

function SurveyIntro({
  name,
  onContinue,
  onBack,
}: {
  name?: string;
  onContinue: () => void;
  onBack: () => void;
}) {
  return (
    <section className="survey-screen survey-screen--intro">
      <button className="round-back round-back--black" onClick={onBack} type="button">
        <ArrowLeftIcon />
      </button>
      <div className="survey-intro-copy">
        <h1>{name ? `Добро пожаловать, ${name}!` : "Добро пожаловать"}</h1>
        <p>
          Предлагаем пройти короткую анкету, чтобы определить ваш профиль здоровья
          и собрать первую подборку рецептов.
        </p>
      </div>
      <Button variant="dark" onClick={onContinue}>
        Продолжить
      </Button>
    </section>
  );
}

function SurveyQuestionScreen({
  title,
  description,
  children,
  onBack,
  footer,
  error,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onBack: () => void;
  footer: ReactNode;
  error: string | null;
}) {
  return (
    <section className="survey-screen">
      <div className="survey-header">
        <button className="round-back round-back--black" onClick={onBack} type="button">
          <ArrowLeftIcon />
        </button>
        <span className="survey-pill">АНКЕТА</span>
      </div>

      <div className="survey-body">
        <h1>{title}</h1>
        {description ? <p className="survey-description">{description}</p> : null}
        {children}
        {error ? <p className="form-error form-error--spaced">{error}</p> : null}
      </div>

      <div className="survey-footer">{footer}</div>
    </section>
  );
}

function SurveyDone({ onStart }: { onStart: () => void }) {
  return (
    <section className="survey-screen survey-screen--done">
      <div className="survey-intro-copy">
        <h1>СПАСИБО!</h1>
        <p>
          Мы подготовили для вас первую подборку рецептов на основе ваших данных.
          Помните: баланс — это ваш МЕРИДИАН.
        </p>
      </div>
      <Button className="survey-done__button" onClick={onStart}>
        Начать
        <ChevronRightIcon />
      </Button>
    </section>
  );
}

function DetailLayout({
  children,
  title,
  onBack,
}: {
  children: ReactNode;
  title: string;
  onBack: () => void;
}) {
  return (
    <section className="detail-layout">
      <header className="detail-layout__header">
        <button className="round-back round-back--black" onClick={onBack} type="button">
          <ArrowLeftIcon />
        </button>
        <h1>{title}</h1>
      </header>
      {children}
    </section>
  );
}

function RecipePreviewCard({
  recipe,
  isFavorite,
  compact,
  onToggleFavorite,
  onOpen,
}: {
  recipe: Recipe;
  isFavorite: boolean;
  compact: boolean;
  onToggleFavorite: () => void;
  onOpen: () => void;
}) {
  const style = {
    "--recipe-bg": recipe.palette.background,
    "--recipe-accent": recipe.palette.accent,
    "--recipe-glow": recipe.palette.imageGlow,
    "--recipe-image-position": recipe.cardImagePosition ?? "center 18%",
  } as CSSProperties;

  return (
    <article
      className={classNames(
        "recipe-card",
        compact ? "recipe-card--compact" : "recipe-card--hero",
        !recipe.cardImage && "recipe-card--placeholder",
        recipe.cardImage && "recipe-card--asset"
      )}
      style={style}
    >
      <button className="recipe-card__open" onClick={onOpen} type="button">
        <div
          className={classNames(
            "recipe-card__media",
            !recipe.cardImage && "recipe-card__media--placeholder"
          )}
        >
          {recipe.cardImage ? (
            <img className="recipe-card__image" src={recipe.cardImage} alt={recipe.title} loading="lazy" />
          ) : (
            <div className="recipe-card__placeholder-note">Фото скоро будет</div>
          )}
          <span className="recipe-card__category">{recipe.category}</span>
        </div>
        <div className={classNames("recipe-card__body", recipe.cardImage && "recipe-card__body--image")}>
          <p className="recipe-card__eyebrow">{recipe.tags.slice(0, 2).join(" • ")}</p>
          <h3>{recipe.title}</h3>
          {!compact ? <p>{recipe.subtitle}</p> : null}
          <div className="recipe-card__stats">
            <span>ГИ {recipe.gi}</span>
            <span>ХЕ {recipe.xe}</span>
            <span>{recipe.calories} ккал</span>
          </div>
        </div>
      </button>
      <button
        className={classNames("favorite-button", isFavorite && "is-active")}
        onClick={onToggleFavorite}
        type="button"
        aria-label="Избранное"
      >
        <HeartIcon filled={isFavorite} />
      </button>
    </article>
  );
}

function BottomNavigation({
  activeTab,
  onChange,
}: {
  activeTab: AppTab;
  onChange: (tab: AppTab) => void;
}) {
  return (
    <nav className="bottom-nav">
      <button
        key="home"
        className={classNames("bottom-nav__item", activeTab === "home" && "is-active")}
        onClick={() => onChange("home")}
        type="button"
      >
        <HomeIcon active={activeTab === "home"} />
        <span>Главная</span>
      </button>
      <button
        key="feed"
        className={classNames("bottom-nav__item", activeTab === "feed" && "is-active")}
        onClick={() => onChange("feed")}
        type="button"
      >
        <FeedIcon active={activeTab === "feed"} />
        <span>Лента</span>
      </button>
      <button
        key="metrics"
        className={classNames("bottom-nav__item", activeTab === "metrics" && "is-active")}
        onClick={() => onChange("metrics")}
        type="button"
      >
        <ChartIcon active={activeTab === "metrics"} />
        <span>Показатели</span>
      </button>
      <button
        key="profile"
        className={classNames("bottom-nav__item", activeTab === "profile" && "is-active")}
        onClick={() => onChange("profile")}
        type="button"
      >
        <ProfileIcon active={activeTab === "profile"} />
        <span>Профиль</span>
      </button>
    </nav>
  );
}

function ModalSurface({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal-surface">
        <div className="modal-surface__header">
          <h2>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <article className="summary-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}

function SectionHeading({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      {subtitle ? <p>{subtitle}</p> : null}
    </div>
  );
}

function Avatar({
  name,
  photo,
  large = false,
}: {
  name: string;
  photo?: string;
  large?: boolean;
}) {
  if (photo) {
    return (
      <div className={classNames("avatar", large && "avatar--large")}>
        <img src={photo} alt={name} />
      </div>
    );
  }

  return (
    <div className={classNames("avatar", large && "avatar--large")}>
      <span>{getInitials(name)}</span>
    </div>
  );
}

function BrandLogo() {
  return (
    <div className="brand-logo">
      <img src="logo.png" alt="Меридиан" />
    </div>
  );
}

function Field({
  label,
  icon,
  className,
  ...inputProps
}: {
  label: string;
  icon?: ReactNode;
  className?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={classNames("field", className)}>
      {label ? <span className="field__label">{label}</span> : null}
      <span className="field__surface">
        {icon ? <span className="field__icon">{icon}</span> : null}
        <input {...inputProps} />
      </span>
    </label>
  );
}

function OptionCard({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={classNames("option-card", selected && "is-selected")}
      onClick={onClick}
      type="button"
    >
      <span>{label}</span>
      <span className="option-card__radio" />
    </button>
  );
}

function Button({
  children,
  variant = "primary",
  className,
  ...props
}: {
  children: ReactNode;
  variant?: "primary" | "soft" | "dark" | "ghost-danger";
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={classNames("button", `button--${variant}`, className)}
      type={props.type ?? "button"}
      {...props}
    >
      {children}
    </button>
  );
}

function getInitialSurveyStepIndex(survey: SurveyAnswers) {
  const stepIndex = surveyQuestions.findIndex((question) => {
    if (question.required === false) {
      return false;
    }

    return !isSurveyQuestionAnswered(question, survey);
  });

  return stepIndex === -1 ? surveyQuestions.length - 1 : stepIndex;
}

function hasSurveyData(survey: SurveyAnswers) {
  return Object.values(survey).some((value) => isSurveyValuePresent(value));
}

function isSurveyComplete(survey: SurveyAnswers) {
  return surveyQuestions.every((question) => {
    if (question.required === false) {
      return true;
    }

    return isSurveyQuestionAnswered(question, survey);
  });
}

function buildVKName(profile: VKUserProfile | null) {
  if (!profile) {
    return null;
  }

  const value = [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
  return value || null;
}

function matchesRecipeCatalogTab(recipe: Recipe, tab: RecipeCatalogTab) {
  if (tab === "Все рецепты") {
    return true;
  }

  if (tab === "Фастфуд") {
    return recipe.cookMinutes <= 15 || recipe.tags.includes("Быстро");
  }

  if (tab === "Овощи") {
    const haystack = [recipe.title, recipe.subtitle, recipe.description, ...recipe.ingredients]
      .join(" ")
      .toLowerCase();

    return (
      recipe.tags.includes("Овощи") ||
      recipe.category === "Салаты" ||
      recipe.category === "Закуски" ||
      haystack.includes("овощ") ||
      haystack.includes("кабач") ||
      haystack.includes("баклаж") ||
      haystack.includes("капуст") ||
      haystack.includes("тыкв")
    );
  }

  if (tab === "Супы") {
    return recipe.category === "Супы";
  }

  return recipe.category === "Рыба";
}

function getRecipeScore(recipe: Recipe, survey: SurveyAnswers) {
  let score = 0;

  if (survey.diabetesType && recipe.safeFor.includes(survey.diabetesType)) {
    score += 3;
  }

  if (survey.therapy && recipe.therapyCompatibility.includes(survey.therapy)) {
    score += 2;
  }

  if (recipe.tags.includes("Низкий ГИ")) {
    score += 2;
  }

  if (survey.hypoglycemia === "Да, часто" && recipe.carbs >= 20 && recipe.carbs <= 32) {
    score += 1;
  }

  return score;
}

function getAverage(values: number[]) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function buildChartPoints(entries: MetricEntry[], range: "7d" | "30d") {
  const points = [...entries]
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime())
    .map((entry) => ({
      label:
        range === "7d"
          ? formatWeekday(entry.timestamp)
          : new Date(entry.timestamp).getDate().toString(),
      value: entry.value,
    }));

  const maxValue = Math.max(...points.map((point) => point.value), 1);

  return points.map((point, index) => ({
    ...point,
    height: Math.max(18, (point.value / maxValue) * 100),
    isAccent: range === "7d" ? index === points.length - 5 : index >= points.length - 5,
  }));
}

function metricEntryTitle(entry: MetricEntry) {
  if (entry.type === "glucose") {
    return "Глюкоза крови";
  }

  if (entry.type === "weight") {
    return "Вес";
  }

  return "Активность";
}

function formatMetricDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
  }).format(new Date(value));
}

function formatMetricTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatLongDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

function formatSigned(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

function getRussianPlural(count: number, forms: [string, string, string]) {
  const absoluteCount = Math.abs(count);
  const remainder10 = absoluteCount % 10;
  const remainder100 = absoluteCount % 100;

  if (remainder10 === 1 && remainder100 !== 11) {
    return forms[0];
  }

  if (remainder10 >= 2 && remainder10 <= 4 && (remainder100 < 12 || remainder100 > 14)) {
    return forms[1];
  }

  return forms[2];
}

function formatAge(age: number) {
  return `${age} ${getRussianPlural(age, ["год", "года", "лет"])}`;
}

function formatReadMinutes(minutes: number) {
  return `${minutes} ${getRussianPlural(minutes, ["минута", "минуты", "минут"])}`;
}

function formatMetricValue(entry: MetricEntry) {
  if (entry.type === "steps") {
    const steps = Math.round(entry.value);
    return `${steps} ${getRussianPlural(steps, ["шаг", "шага", "шагов"])}`;
  }

  return `${entry.value} ${entry.unit}`;
}

function buildPatientId(id: string) {
  return `MDN-${id.slice(0, 5).toUpperCase()}`;
}

function formatSavedRecipes(count: number) {
  return `${count} ${getRussianPlural(count, [
    "сохраненный рецепт",
    "сохраненных рецепта",
    "сохраненных рецептов",
  ])}`;
}

function getGreetingWord() {
  const hours = new Date().getHours();

  if (hours < 12) {
    return "утро";
  }

  if (hours < 18) {
    return "день";
  }

  return "вечер";
}

function getFirstName(name: string) {
  return name.split(" ")[0] ?? name;
}

function getInitials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function shortenTherapy(value?: string) {
  if (!value) {
    return "—";
  }

  if (value.includes("Инсулинотерапия")) {
    return "Инсулин";
  }

  if (value.includes("таблетки + инсулин")) {
    return "Комбо";
  }

  if (value.includes("таблетки")) {
    return "Таблетки";
  }

  if (value.includes("Ничего")) {
    return "Без терапии";
  }

  return "Диета и активность";
}

function formatWeekday(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { weekday: "short" })
    .format(new Date(value))
    .replace(".", "");
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function IconWrapper({
  children,
  active = false,
  filled = false,
}: {
  children: ReactNode;
  active?: boolean;
  filled?: boolean;
}) {
  return (
    <span className={classNames("icon", active && "icon--active", filled && "icon--filled")}>
      {children}
    </span>
  );
}

function HomeIcon({ active = false }: { active?: boolean }) {
  return (
    <img
      className="nav-icon"
      src={`icons-navbar/${active ? 'home-active' : 'home'}.svg`}
      alt="Главная"
      width={24}
      height={24}
    />
  );
}

function FeedIcon({ active = false }: { active?: boolean }) {
  return (
    <img
      className="nav-icon"
      src={`icons-navbar/${active ? 'lenta-active' : 'lenta'}.svg`}
      alt="Лента"
      width={24}
      height={24}
    />
  );
}

function ChartIcon({ active = false }: { active?: boolean }) {
  return (
    <img
      className="nav-icon"
      src={`icons-navbar/${active ? 'stats-active' : 'stats'}.svg`}
      alt="Статистика"
      width={24}
      height={24}
    />
  );
}

function ProfileIcon({ active = false }: { active?: boolean }) {
  return (
    <img
      className="nav-icon"
      src={`icons-navbar/${active ? 'user-active' : 'user'}.svg`}
      alt="Профиль"
      width={24}
      height={24}
    />
  );
}

function ProfileDataIcon() {
  return (
    <img
      className="profile-asset-icon"
      src="icons-in-profile/profile_data.svg"
      alt="Личные данные"
      width={24}
      height={24}
    />
  );
}

function SavedIcon() {
  return (
    <img
      className="profile-asset-icon"
      src="icons-in-profile/saved.svg"
      alt="Избранное"
      width={24}
      height={24}
    />
  );
}

function StatsIcon() {
  return (
    <img
      className="profile-asset-icon"
      src="icons-in-profile/stats.svg"
      alt="Статистика"
      width={24}
      height={24}
    />
  );
}

function NotificationsIcon() {
  return (
    <img
      className="profile-asset-icon"
      src="icons-in-profile/notifications.svg"
      alt="Уведомления"
      width={24}
      height={24}
    />
  );
}

function SearchIcon() {
  return (
    <IconWrapper>
      <svg viewBox="0 0 24 24" fill="none">
        <circle cx="10.5" cy="10.5" r="5.5" />
        <path d="m15 15 4 4" />
      </svg>
    </IconWrapper>
  );
}

function HeartIcon({ filled = false }: { filled?: boolean }) {
  return (
    <IconWrapper filled={filled}>
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M12 20s-6.5-3.9-8.3-8A4.8 4.8 0 0 1 12 6a4.8 4.8 0 0 1 8.3 6c-1.8 4.1-8.3 8-8.3 8Z" />
      </svg>
    </IconWrapper>
  );
}

function ArrowLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="m14.5 6.5-5 5 5 5" />
    </svg>
  );
}

function LockIcon() {
  return (
    <IconWrapper>
      <svg viewBox="0 0 24 24" fill="none">
        <rect x="5" y="10" width="14" height="10" rx="2" />
        <path d="M8 10V8a4 4 0 0 1 8 0v2" />
      </svg>
    </IconWrapper>
  );
}

function MailIcon() {
  return (
    <IconWrapper>
      <svg viewBox="0 0 24 24" fill="none">
        <rect x="4" y="6" width="16" height="12" rx="2" />
        <path d="m5.5 8 6.5 5 6.5-5" />
      </svg>
    </IconWrapper>
  );
}

function UserIcon() {
  return (
    <IconWrapper>
      <svg viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="8" r="3.2" />
        <path d="M6.5 18.2c1.5-2.5 3.4-3.7 5.5-3.7s4 1.2 5.5 3.7" />
      </svg>
    </IconWrapper>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="m10 7 5 5-5 5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ScaleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <rect x="5" y="5" width="14" height="14" rx="3" />
      <path d="M12 9v4M8.5 10.5 12 9l3.5 1.5" />
    </svg>
  );
}

function ActivityIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M5 15h3l2-6 4 10 2-4h3" />
    </svg>
  );
}

function DropletIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M12 4s5 5 5 8.5a5 5 0 1 1-10 0C7 9 12 4 12 4Z" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M7 16V11a5 5 0 1 1 10 0v5l1.5 2h-13L7 16Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </svg>
  );
}
