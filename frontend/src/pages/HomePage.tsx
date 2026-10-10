import { Link } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Clock3,
  Globe2,
  Mail,
  Rss,
  Sparkles,
  SlidersHorizontal,
  BookOpen,
  Layers3,
  ChevronRight,
} from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import screenshots from "../../public/documentation/screenshots.json";

const features = [
  {
    icon: Rss,
    tag: "VOS SOURCES",
    title: "RSS ou site web. À vous de choisir.",
    text: "Rassemblez vos flux RSS et les pages d’actualité qui vous intéressent dans un seul espace.",
  },
  {
    icon: Sparkles,
    tag: "VOTRE ASSISTANT",
    title: "L’IA vous aide à faire le premier pas.",
    text: "Proposez une page. L’IA suggère les sélecteurs pour configurer votre source. Vous vérifiez l’aperçu avant de l’enregistrer.",
  },
  {
    icon: SlidersHorizontal,
    tag: "VOTRE RYTHME",
    title: "Gardez la main sur votre veille.",
    text: "Activez vos sources, choisissez vos journaux et programmez l’heure de votre brief. Suivez chaque article pendant la collecte.",
  },
];

export function HomePage() {
  const { user } = useAuth();
  const start = user ? "/dashboard" : "/register";
  return (
    <main id="contenu" className="home-main" tabIndex={-1}>
      <section className="home-hero public-container">
        <div className="hero-copy">
          <p className="public-eyebrow">
            <span className="status-dot" /> Votre veille, simplement
          </p>
          <h1>
            Moins d’onglets.
            <br />
            Plus <em>d’essentiel.</em>
          </h1>
          <p className="hero-description">
            Vos sources préférées, résumées par l’IA et réunies dans un email. Commencez la journée
            avec les idées qui comptent pour vous.
          </p>
          <div className="hero-actions">
            <Link to={start} className="public-button">
              {user ? "Retrouver ma veille" : "Créer ma veille"}
              <ArrowUpRight size={19} aria-hidden="true" />
            </Link>
            <Link to="/documentation#premiers-pas" className="public-text-link">
              Comment ça marche <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>
          <p className="hero-note">
            <Check size={15} aria-hidden="true" /> Vos sources. Votre horaire. Votre boîte mail.
          </p>
        </div>
        <div className="hero-preview" aria-label="Exemple illustratif d’un brief quotidien">
          <div className="preview-orbit orbit-one" />
          <div className="preview-orbit orbit-two" />
          <div className="floating-source">
            <Rss size={17} aria-hidden="true" />
            <span>Vos flux RSS</span>
            <Globe2 size={17} aria-hidden="true" />
            <span>Vos sites</span>
          </div>
          <div className="brief-preview">
            <div className="brief-top">
              <span className="brand-symbol">
                <Mail size={18} aria-hidden="true" />
              </span>
              <strong>DailyBrief.</strong>
              <span>ÉDITION DU MATIN</span>
            </div>
            <div className="brief-body">
              <p className="brief-date">07:30 · LE TEMPS DE PRENDRE DU RECUL</p>
              <h2>
                Bonjour, vous.
                <br />
                Voici votre essentiel.
              </h2>
              <p className="brief-intro">Un aperçu de votre prochaine lecture.</p>
              {[
                [
                  "01",
                  "TECHNOLOGIE",
                  "L’IA entre dans le quotidien des équipes",
                  "Les usages évoluent : outils plus accessibles, nouvelles méthodes et décisions mieux informées.",
                ],
                [
                  "02",
                  "CULTURE",
                  "Des idées qui donnent une autre perspective",
                  "Retrouvez les points clés de vos lectures, puis ouvrez l’article pour aller plus loin.",
                ],
              ].map(([n, category, title, text]) => (
                <div className="brief-article" key={n}>
                  <span>{n}</span>
                  <div>
                    <p>{category}</p>
                    <h3>{title}</h3>
                    <p>{text}</p>
                    <span className="brief-read">
                      Lire l’article <ArrowUpRight size={13} aria-hidden="true" />
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <div className="brief-bottom">
              <Sparkles size={14} aria-hidden="true" /> Exemple de présentation · contenu
              illustratif
            </div>
          </div>
          <div className="floating-ready">
            <span>
              <Check size={17} aria-hidden="true" />
            </span>
            <div>
              <strong>Votre brief est prêt</strong>
              <p>Un rendez-vous avec vos idées.</p>
            </div>
          </div>
        </div>
      </section>
      <div className="home-capabilities public-container">
        <span>
          <Rss size={19} aria-hidden="true" /> Flux RSS
        </span>
        <span>
          <Globe2 size={19} aria-hidden="true" /> Scraping de pages web
        </span>
        <span>
          <Sparkles size={19} aria-hidden="true" /> Résumés IA
        </span>
        <span>
          <Mail size={19} aria-hidden="true" /> Newsletter personnelle
        </span>
      </div>
      <section className="home-section public-container" id="fonctionnement">
        <div className="section-heading">
          <p className="public-eyebrow">DE LA SOURCE À L’ESSENTIEL</p>
          <h2>
            Une petite routine.
            <br />
            <em>De grandes perspectives.</em>
          </h2>
          <p>Choisissez ce que vous lisez. DailyBrief s’occupe de rassembler votre veille.</p>
        </div>
        <div className="home-steps">
          {[
            [
              "01",
              Layers3,
              "Rassemblez vos sources",
              "Ajoutez un flux RSS ou une page web. Vérifiez les articles détectés avant d’enregistrer.",
            ],
            [
              "02",
              Sparkles,
              "Laissez l’IA synthétiser",
              "Lancez la collecte : les articles accessibles sont récupérés et résumés avec leurs points clés.",
            ],
            [
              "03",
              Mail,
              "Ouvrez votre brief",
              "Recevez les nouveaux articles dans votre boîte mail, à la demande ou à l’heure choisie.",
            ],
          ].map(([number, Icon, title, text]) => {
            const StepIcon = Icon as typeof Mail;
            return (
              <article key={String(number)}>
                <div className="step-top">
                  <span>{String(number)}</span>
                  <StepIcon size={24} aria-hidden="true" />
                </div>
                <h3>{String(title)}</h3>
                <p>{String(text)}</p>
              </article>
            );
          })}
        </div>
      </section>
      <section className="home-product public-container">
        <div className="product-copy">
          <p className="public-eyebrow">UN ESPACE QUI RESPIRE</p>
          <h2>
            Votre veille.
            <br />
            <em>Vos règles.</em>
          </h2>
          <p>
            Programmez votre rendez-vous quotidien ou lancez une collecte quand vous en avez besoin.
            La progression reste disponible même après un rechargement.
          </p>
          <Link className="public-text-link" to="/documentation#collecte">
            Découvrir le tableau de bord <ArrowRight size={18} aria-hidden="true" />
          </Link>
          <div className="product-note">
            <Clock3 size={19} aria-hidden="true" />
            <span>Le bon contenu, au bon moment.</span>
          </div>
        </div>
        <figure className="product-screen">
          <div className="screen-bar">
            <i />
            <i />
            <i />
            <span>Votre espace DailyBrief</span>
          </div>
          <img
            src="/documentation/dashboard.png"
            width={screenshots.dashboard.width}
            height={screenshots.dashboard.height}
            alt="Tableau de bord de démonstration : réglages de collecte quotidienne et récupération manuelle"
            loading="lazy"
          />
          <figcaption>Capture du produit avec des données de démonstration.</figcaption>
        </figure>
      </section>
      <section className="home-section public-container">
        <div className="section-heading">
          <p className="public-eyebrow">PENSÉ POUR VOTRE CURIOSITÉ</p>
          <h2>Une veille qui vous ressemble.</h2>
        </div>
        <div className="feature-grid">
          {features.map(({ icon: Icon, tag, title, text }) => (
            <article key={tag}>
              <span className="feature-icon">
                <Icon size={25} aria-hidden="true" />
              </span>
              <p className="feature-tag">{tag}</p>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="home-guide public-container">
        <div className="guide-art" aria-hidden="true">
          <BookOpen size={70} strokeWidth={1.2} />
          <span>Un pas après l’autre.</span>
        </div>
        <div>
          <p className="public-eyebrow">PAS BESOIN D’ÊTRE DÉVELOPPEUR</p>
          <h2>Vous êtes bien accompagné.</h2>
          <p>
            Des captures d’écran, des exemples et un exercice interactif pour comprendre les
            sélecteurs. L’aide de l’IA est directement disponible dans vos formulaires.
          </p>
          <Link to="/documentation" className="public-button public-button-light">
            Ouvrir le guide <ArrowUpRight size={18} aria-hidden="true" />
          </Link>
        </div>
      </section>
      <section className="home-faq public-container">
        <div>
          <p className="public-eyebrow">QUELQUES RÉPONSES</p>
          <h2>
            Avant votre
            <br />
            <em>premier brief.</em>
          </h2>
        </div>
        <div>
          {[
            [
              "Faut-il savoir coder pour ajouter une source ?",
              "Un flux RSS direct demande seulement son URL. Pour une page web ou un RSS avec notice intermédiaire, le bouton « Remplir avec l’IA » propose les sélecteurs. Le guide vous aide à les vérifier et à les ajuster.",
            ],
            [
              "Puis-je utiliser un journal avec abonnement ?",
              "Vous pouvez enregistrer des identifiants chiffrés et configurer son formulaire de connexion. Il faut tester cet accès : les CAPTCHA, la double authentification et certains systèmes externes ne sont pas automatisés. Un abonnement valide reste nécessaire.",
            ],
            [
              "Que se passe-t-il si je ferme la page ?",
              "Une collecte lancée continue côté serveur. Retrouvez sa progression à votre retour et le détail de chaque article dans la page Jobs.",
            ],
            [
              "Comment vérifier le résultat avant de recevoir un email ?",
              "L’action « Tester le workflow de A à Z » affiche les articles et permet de tester un résumé. Ce test n’envoie aucun email et ne modifie pas les articles, résumés ou newsletters existants.",
            ],
          ].map(([q, a]) => (
            <details key={q}>
              <summary>
                {q}
                <ChevronRight size={19} aria-hidden="true" />
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>
      <section className="home-cta public-container">
        <span className="cta-icon">
          <Mail size={28} aria-hidden="true" />
        </span>
        <p className="public-eyebrow">FAITES DE LA PLACE À L’ESSENTIEL</p>
        <h2>
          Votre prochain matin
          <br />
          commence ici.
        </h2>
        <Link to={start} className="public-button">
          {user ? "Ouvrir mon espace" : "Créer ma veille"}
          <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
        <Link to="/documentation" className="public-text-link">
          Je préfère découvrir le guide
        </Link>
      </section>
    </main>
  );
}
