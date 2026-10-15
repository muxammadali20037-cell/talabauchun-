import { lazy, Suspense, useEffect, useRef } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { useT } from "./lib/i18n";
import { Shell } from "./components/Shell";
import { Loading } from "./components/ui";
import { OutsideTelegram } from "./screens/OutsideTelegram";
import { Onboarding } from "./screens/Onboarding";
import { Home } from "./screens/Home";

const Create = lazy(() => import("./screens/Create").then((m) => ({ default: m.Create })));
const Library = lazy(() => import("./screens/Library").then((m) => ({ default: m.Library })));
const DocumentDetail = lazy(() => import("./screens/DocumentDetail").then((m) => ({ default: m.DocumentDetail })));
const PageView = lazy(() => import("./screens/DocumentDetail").then((m) => ({ default: m.PageView })));
const QuizNew = lazy(() => import("./screens/QuizNew").then((m) => ({ default: m.QuizNew })));
const QuizEditor = lazy(() => import("./screens/QuizEditor").then((m) => ({ default: m.QuizEditor })));
const QuizList = lazy(() => import("./screens/QuizList").then((m) => ({ default: m.QuizList })));
const Practice = lazy(() => import("./screens/Practice").then((m) => ({ default: m.Practice })));
const Join = lazy(() => import("./screens/Join").then((m) => ({ default: m.Join })));
const Assignment = lazy(() => import("./screens/Assignment").then((m) => ({ default: m.Assignment })));
const Room = lazy(() => import("./screens/Room").then((m) => ({ default: m.Room })));
const Groups = lazy(() => import("./screens/Groups").then((m) => ({ default: m.Groups })));
const Profile = lazy(() => import("./screens/Profile").then((m) => ({ default: m.Profile })));
const InfoPage = lazy(() => import("./screens/InfoPage").then((m) => ({ default: m.InfoPage })));
const Cards = lazy(() => import("./screens/study/Cards").then((m) => ({ default: m.Cards })));
const Mistakes = lazy(() => import("./screens/study/Mistakes").then((m) => ({ default: m.Mistakes })));
const Plans = lazy(() => import("./screens/study/Plans").then((m) => ({ default: m.Plans })));
const PlanNew = lazy(() => import("./screens/study/Plans").then((m) => ({ default: m.PlanNew })));
const PlanDetail = lazy(() => import("./screens/study/Plans").then((m) => ({ default: m.PlanDetail })));
const Tutor = lazy(() => import("./screens/study/Tutor").then((m) => ({ default: m.Tutor })));
const Summary = lazy(() => import("./screens/study/Summary").then((m) => ({ default: m.Summary })));
const Stats = lazy(() => import("./screens/study/Stats").then((m) => ({ default: m.Stats })));
const Writing = lazy(() => import("./screens/study/Writing").then((m) => ({ default: m.Writing })));
const Matching = lazy(() => import("./screens/study/Matching").then((m) => ({ default: m.Matching })));
const WorkspaceNew = lazy(() => import("./screens/workspaces/Workspaces").then((m) => ({ default: m.WorkspaceNew })));
const WorkspaceJoin = lazy(() => import("./screens/workspaces/Workspaces").then((m) => ({ default: m.WorkspaceJoin })));
const WorkspaceDetail = lazy(() => import("./screens/workspaces/Workspaces").then((m) => ({ default: m.WorkspaceDetail })));
const Billing = lazy(() => import("./screens/account/Billing").then((m) => ({ default: m.Billing })));
const MyData = lazy(() => import("./screens/account/MyData").then((m) => ({ default: m.MyData })));
const Support = lazy(() => import("./screens/account/Support").then((m) => ({ default: m.Support })));
const AdminRoutes = lazy(() => import("./screens/admin/Admin").then((m) => ({ default: m.AdminRoutes })));
const DeckRoutes = lazy(() => import("./screens/decks/DeckRoutes").then((m) => ({ default: m.DeckRoutes })));

export function App() {
  const { state } = useAuth();
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const handledStart = useRef(false);

  // Invite links (t.me/<bot>?startapp=r<token> for rooms, w<token> for group workspaces) open straight into the invite; onboarding never blocks that path.
  useEffect(() => {
    if (state.status !== "ready" || handledStart.current) return;
    handledStart.current = true;
    // a reload inside the same Telegram session carries the same start_param: open the invite only once, keep the user's screen after that
    let sp = state.startParam;
    try {
      if (sp && sessionStorage.getItem("startParam.handled") === sp) sp = null;
      else if (sp) sessionStorage.setItem("startParam.handled", sp);
    } catch {
      // storage unavailable: open the invite as before
    }
    if (sp && sp.startsWith("r") && sp.length > 10) navigate(`/join/${sp.slice(1)}`, { replace: true });
    else if (sp && sp.startsWith("w") && sp.length > 10) navigate(`/workspaces/join/${sp.slice(1)}`, { replace: true });
    else if (!state.me.user.onboarded && location.pathname === "/") navigate("/onboarding", { replace: true });
  }, [state, navigate, location.pathname]);

  if (state.status === "loading")
    return (
      <div className="app">
        <main className="main no-nav" aria-label={t("common.loading")}>
          <Loading lines={4} />
        </main>
      </div>
    );
  if (state.status === "outside_telegram" || state.status === "error") return <OutsideTelegram code={state.status === "error" ? state.code : null} />;

  return (
    <Shell>
      <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/create" element={<Create />} />
        <Route path="/library" element={<Library />} />
        <Route path="/library/upload" element={<Library openUpload />} />
        <Route path="/library/:id" element={<DocumentDetail />} />
        <Route path="/library/:id/page/:n" element={<PageView />} />
        <Route path="/quizzes" element={<QuizList />} />
        <Route path="/quiz/new" element={<QuizNew />} />
        <Route path="/quiz/:id/edit" element={<QuizEditor />} />
        <Route path="/attempt/:id" element={<Practice />} />
        <Route path="/join/:token" element={<Join />} />
        <Route path="/room/:id" element={<Room />} />
        <Route path="/assignment/:id" element={<Assignment />} />
        <Route path="/groups" element={<Groups />} />
        <Route path="/workspaces/new" element={<WorkspaceNew />} />
        <Route path="/workspaces/join/:token" element={<WorkspaceJoin />} />
        <Route path="/workspaces/:id" element={<WorkspaceDetail />} />
        <Route path="/cards" element={<Cards />} />
        <Route path="/mistakes" element={<Mistakes />} />
        <Route path="/plans" element={<Plans />} />
        <Route path="/plans/new" element={<PlanNew />} />
        <Route path="/plans/:id" element={<PlanDetail />} />
        <Route path="/tutor" element={<Tutor />} />
        <Route path="/library/:id/summary" element={<Summary />} />
        <Route path="/library/:id/stats" element={<Stats />} />
        <Route path="/games/matching" element={<Matching />} />
        <Route path="/writing" element={<Writing />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/profile/data" element={<MyData />} />
        <Route path="/billing" element={<Billing />} />
        <Route path="/support" element={<Support />} />
        <Route path="/admin/*" element={<AdminRoutes />} />
        <Route path="/terms" element={<InfoPage kind="terms" />} />
        <Route path="/privacy" element={<InfoPage kind="privacy" />} />
        <Route path="/help" element={<InfoPage kind="help" />} />
        <Route path="/decks/*" element={<DeckRoutes />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </Shell>
  );
}
