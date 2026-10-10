import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  BookOpen,
  Search,
  Sparkles,
  Info,
  Rss,
  Globe2,
  MousePointer2,
} from "lucide-react";
import { SelectorPlayground } from "@/documentation/SelectorPlayground";
import screenshots from "../../public/documentation/screenshots.json";

const chapters = [
  ["premiers-pas", "Vos premiers pas", "compte démarrer inscription tableau de bord"],
  ["rss", "Créer un flux RSS", "notice lien intermédiaire INP journal"],
  ["scraping", "Créer une source de scraping", "site description date pagination scroll bouton"],
  ["selecteurs", "Trouver les sélecteurs", "inspecter HTML CSS navigateur exemple exercice"],
  ["assistance-ia", "Se faire aider par l’IA", "remplir analyse aide email erreur"],
  [
    "journaux",
    "Configurer les journaux",
    "abonnement connexion mot de passe accès session domaine",
  ],
  ["workflow", "Tester de A à Z", "aperçu résumé test source"],
  [
    "collecte",
    "Recevoir et suivre son brief",
    "jobs collecte récupération automatique heure newsletter progression",
  ],
  ["depannage", "Résoudre un problème", "403 erreur lent doublon email aucun article"],
  ["glossaire", "Le petit lexique", "définition RSS scraping sélecteur job domaine"],
] as const;

function Chapter({
  id,
  number,
  title,
  children,
}: {
  id: string;
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} tabIndex={-1} className="doc-chapter">
      <p className="doc-chapter-number">GUIDE / {number}</p>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
function Tip({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="doc-tip">
      <Info size={19} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <div>{children}</div>
      </div>
    </aside>
  );
}
function Screenshot({
  name,
  alt,
  caption,
  width = 1140,
  height = 700,
}: {
  name: string;
  alt: string;
  caption: string;
  width?: number;
  height?: number;
}) {
  const dimensions = screenshots[name as keyof typeof screenshots];
  width = dimensions?.width ?? width;
  height = dimensions?.height ?? height;
  return (
    <figure className="doc-screenshot">
      <a
        href={`/documentation/${name}.png`}
        target="_blank"
        rel="noreferrer"
        aria-label={`Agrandir : ${alt}`}
      >
        <img
          src={`/documentation/${name}.png`}
          width={width}
          height={height}
          alt={alt}
          loading="lazy"
        />
      </a>
      <figcaption>
        {caption} <span>Capture de démonstration · cliquez pour agrandir.</span>
      </figcaption>
    </figure>
  );
}
function Steps({ children }: { children: ReactNode }) {
  return <ol className="doc-steps">{children}</ol>;
}
function Table({ headings, rows }: { headings: string[]; rows: ReactNode[][] }) {
  return (
    <div className="doc-table-scroll" role="region" tabIndex={0} aria-label={headings.join(", ")}>
      <table>
        <thead>
          <tr>
            {headings.map((heading) => (
              <th scope="col" key={heading}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DocumentationPage() {
  const [query, setQuery] = useState("");
  const needle = query
    .trim()
    .toLocaleLowerCase("fr")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  const visible = chapters.filter((chapter) =>
    chapter
      .join(" ")
      .toLocaleLowerCase("fr")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .includes(needle),
  );
  return (
    <main id="contenu" tabIndex={-1} className="documentation-main public-container">
      <header className="doc-intro">
        <p className="public-eyebrow">
          <BookOpen size={16} aria-hidden="true" /> LE GUIDE DAILYBRIEF
        </p>
        <h1>
          Votre veille commence
          <br />
          <em>par ici.</em>
        </h1>
        <p>
          Du premier flux RSS au brief du matin : suivez le guide à votre rythme. Avec des exemples,
          des captures du produit et un peu d’aide de l’IA.
        </p>
        <div className="doc-shortcuts">
          <a href="#rss">
            <Rss size={17} aria-hidden="true" /> J’ai un flux RSS{" "}
            <ArrowUpRight size={15} aria-hidden="true" />
          </a>
          <a href="#scraping">
            <Globe2 size={17} aria-hidden="true" /> J’ai une page web{" "}
            <ArrowUpRight size={15} aria-hidden="true" />
          </a>
          <a href="#selecteurs">
            <MousePointer2 size={17} aria-hidden="true" /> Comprendre les sélecteurs{" "}
            <ArrowUpRight size={15} aria-hidden="true" />
          </a>
        </div>
      </header>
      <div className="doc-layout">
        <aside className="doc-sidebar">
          <label htmlFor="doc-search">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Rechercher un chapitre</span>
            <input
              id="doc-search"
              type="search"
              placeholder="Chercher dans le guide…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <p>AU SOMMAIRE</p>
          <nav aria-label="Sommaire de la documentation">
            {visible.map(([id, title]) => (
              <a href={`#${id}`} key={id}>
                {title}
                <ArrowUpRight size={13} aria-hidden="true" />
              </a>
            ))}
          </nav>
          {!visible.length && (
            <span role="status">Aucun chapitre trouvé. Essayez « RSS » ou « IA ».</span>
          )}
          <div className="doc-sidebar-help">
            <Sparkles size={22} aria-hidden="true" />
            <strong>Un coup de pouce ?</strong>
            <p>L’IA peut remplir vos réglages directement dans les formulaires.</p>
            <a href="#assistance-ia">Découvrir l’assistance →</a>
          </div>
        </aside>
        <div className="doc-content">
          <Chapter id="premiers-pas" number="01" title="Votre premier brief, pas à pas">
            <p>
              DailyBrief rassemble vos sources d’actualité, récupère les articles accessibles,
              produit des résumés IA et vous envoie une newsletter personnelle. Vous choisissez les
              sites et le rythme de collecte.
            </p>
            <Steps>
              <li>
                <strong>Créez votre compte.</strong> Utilisez{" "}
                <Link to="/register">Créer un compte</Link>, renseignez votre email et un mot de
                passe d’au moins 12 caractères, avec une majuscule, une minuscule et un chiffre.
                Confirmez-le, puis connectez-vous. Le brief sera envoyé à l’adresse de votre compte.
              </li>
              <li>
                <strong>Ajoutez une source.</strong> Ouvrez <Link to="/sources">Sources</Link>.
                Choisissez RSS si le site propose un flux ; choisissez SCRAPING si vous partez d’une
                page qui liste des articles.
              </li>
              <li>
                <strong>Vérifiez votre configuration.</strong> Dans le formulaire, cliquez sur{" "}
                <b>Tester</b>, contrôlez l’aperçu puis enregistrez. Vous pouvez ensuite utiliser
                l’icône de test du workflow dans la liste des sources.
              </li>
              <li>
                <strong>Choisissez les journaux à activer.</strong> Pour les RSS avec notice
                intermédiaire, les domaines découverts sont désactivés par défaut. Activez ceux que
                vous souhaitez lire dans <Link to="/journals">Journaux</Link>.
              </li>
              <li>
                <strong>Lancez votre première collecte.</strong> Sur le{" "}
                <Link to="/dashboard">Tableau de bord</Link>, cliquez sur{" "}
                <b>Récupérer maintenant</b>. Retrouvez la progression dans la bannière et le détail
                dans <Link to="/jobs">Jobs</Link>.
              </li>
            </Steps>
            <Screenshot
              name="sources"
              height={430}
              alt="Liste des sources RSS avec onglets, recherche, filtre et icônes d’action"
              caption="Dans Sources, les onglets RSS et SCRAPING séparent les deux types de veille."
            />
            <Tip title="Prenez le temps de vérifier le premier aperçu">
              <p>
                Le test d’une source sert à vérifier sa configuration. Le bouton Récupérer
                maintenant déclenche une vraie collecte et peut envoyer un email lorsqu’un brief est
                prêt.
              </p>
            </Tip>
          </Chapter>
          <Chapter id="rss" number="02" title="Créer un flux RSS">
            <p>
              Un flux RSS est une liste d’articles mise à jour par un site. Son adresse se termine
              parfois par <code>/feed</code>, <code>/rss</code> ou <code>.xml</code>, mais ce n’est
              pas une règle. Cherchez un lien « RSS » sur le site et copiez l’adresse du flux,
              plutôt que celle d’un article ou d’une rubrique.
            </p>
            <h3>Le cas simple : un flux qui mène aux articles</h3>
            <Steps>
              <li>
                Dans <b>Sources → RSS</b>, cliquez sur <b>Ajouter un flux RSS</b>.
              </li>
              <li>
                Collez l’adresse dans <b>URL du flux RSS</b>. Exemple de format :{" "}
                <code>https://exemple.fr/feed.xml</code> (adresse fictive).
              </li>
              <li>
                Laissez le sélecteur de lien intermédiaire vide si chaque item pointe directement
                vers un article.
              </li>
              <li>
                Cliquez sur <b>Tester</b>. Vérifiez les titres, dates, descriptions et liens dans
                l’aperçu. Ouvrez un lien pour confirmer qu’il mène au bon article.
              </li>
              <li>
                Cliquez sur <b>Enregistrer le flux</b>. Toute modification des réglages nécessite un
                nouveau test avant l’enregistrement.
              </li>
            </Steps>
            <Screenshot
              name="rss"
              height={490}
              alt="Formulaire RSS avec URL du flux, bouton Remplir avec l’IA et sélecteur de lien"
              caption="Un flux direct n’a pas besoin de sélecteur de lien intermédiaire."
            />
            <h3>Le cas particulier : une notice avant l’article</h3>
            <p>
              Certains flux pointent vers une notice de bibliothèque ou un portail. Le vrai lien de
              lecture se trouve sur cette notice. Renseignez le sélecteur de ce lien, ou utilisez{" "}
              <b>Remplir avec l’IA</b> pour demander une proposition.
            </p>
            <pre>
              <code>{`<!-- Exemple : lien présent sur une notice INP -->\n<a class="accessToPrimaryDoc primarydoc" href="https://www.lemonde.fr/...">\n  Consulter le document\n</a>\n\nSélecteur à utiliser : a.accessToPrimaryDoc.primarydoc`}</code>
            </pre>
            <p>
              Ici, l’item RSS vient de <code>bibliotheques.inp.fr</code>, mais le journal recensé
              est <code>www.lemonde.fr</code>. DailyBrief conserve la notice et le lien externe ; le
              lien de lecture pointe vers le journal.
            </p>
            <Tip title="N’oubliez pas l’activation du journal">
              <p>
                Le workflow recense aussi les items déjà présents en base et les journaux
                désactivés, sans lire le contenu complet ni appeler l’IA pour les résumer. Un
                domaine désactivé reste visible et comptabilisé, mais ses articles sont ignorés lors
                de la collecte.
              </p>
            </Tip>
          </Chapter>
          <Chapter id="scraping" number="03" title="Créer une source de scraping">
            <p>
              Le scraping permet de lire une page web qui liste plusieurs articles. DailyBrief ouvre
              la page dans un navigateur. Vous indiquez quelles parties représentent un article, son
              titre, son lien, sa description et sa date.
            </p>
            <Steps>
              <li>
                Ouvrez <b>Sources → SCRAPING → Ajouter une source de scraping</b>.
              </li>
              <li>
                Collez l’URL de la rubrique à suivre dans <b>URL du site</b>, par exemple une page
                d’actualités sur le cloud.
              </li>
              <li>
                Essayez <b>Remplir avec l’IA</b>. Vous pouvez aussi renseigner les cinq sélecteurs
                vous-même à l’aide du chapitre suivant.
              </li>
              <li>
                Choisissez le mode qui correspond à la manière dont le site affiche les articles
                suivants.
              </li>
              <li>
                Cliquez sur <b>Tester</b>, vérifiez plusieurs articles de l’aperçu, puis sur{" "}
                <b>Enregistrer la source</b>.
              </li>
            </Steps>
            <Table
              headings={["Champ obligatoire", "Ce qu’il désigne", "Exemple"]}
              rows={[
                [
                  "Sélecteur des articles",
                  "Le bloc répété autour de chaque article",
                  <code>.article-card</code>,
                ],
                ["Sélecteur du titre", "Le titre à l’intérieur de ce bloc", <code>h2</code>],
                ["Sélecteur du lien", "Un lien portant un attribut href", <code>h2 a.title</code>],
                [
                  "Sélecteur de description",
                  "Le court texte qui présente l’article",
                  <code>.description</code>,
                ],
                ["Sélecteur de date", "La date de publication affichée", <code>time</code>],
              ]}
            />
            <p>
              Les sélecteurs de titre, lien, description et date se cherchent{" "}
              <strong>à l’intérieur de chaque bloc article</strong>. La description et la date sont
              obligatoires à la création et à la modification. Si la page ne fournit pas de
              description, utilisez le sélecteur du titre : l’assistance IA applique ce remplacement
              automatiquement. Si la date est absente, choisissez une autre rubrique qui l’affiche
              ou demandez de l’aide. L’analyse vérifie les liens de pagination, les boutons de
              chargement et l’ajout de liens d’articles lors d’un court scroll dans le navigateur
              pour remplir le mode de récupération. Le résultat indique si le scroll a été observé
              ou si ce mode reste à vérifier.
            </p>
            <Screenshot
              name="scraping"
              height={820}
              alt="Source de scraping configurée avec les cinq sélecteurs requis et le mode Scroll infini"
              caption="Exemple : une carte .article-card contenant h2, un lien, .description et time."
            />
            <h3>Choisir comment charger la suite</h3>
            <Table
              headings={[
                "Ce que vous voyez sur le site",
                "Mode dans DailyBrief",
                "Réglages à vérifier",
              ]}
              rows={[
                [
                  "Des articles apparaissent en faisant défiler la page",
                  "Scroll infini",
                  "Nombre de scrolls et attente après chacun. Pour une page fixe, vous pouvez choisir 0 scroll.",
                ],
                [
                  "Un bouton « Voir plus » ou « Charger plus »",
                  "Bouton charger plus",
                  "Sélecteur CSS du bouton, par exemple .load-more, et délai maximum après un clic. Le parcours s’arrête quand il n’ajoute plus d’articles.",
                ],
                [
                  "Des pages 1, 2, 3…",
                  "Pagination",
                  <>
                    Paramètre de l’URL (<code>?page=2</code>) ou modèle (
                    <code>https://exemple.fr/actualites/page/&#123;page&#125;</code>). Vérifiez le
                    numéro de départ.
                  </>,
                ],
              ]}
            />
            <Tip title="Vérifiez plusieurs cartes">
              <p>
                Un sélecteur doit fonctionner sur tous les articles de la rubrique. Un aperçu vide,
                des dates incohérentes ou des liens vers le menu indiquent qu’il faut ajuster les
                réglages avant d’enregistrer.
              </p>
            </Tip>
          </Chapter>
          <Chapter id="selecteurs" number="04" title="Trouver un sélecteur dans une page web">
            <p>
              Un sélecteur CSS est une courte expression qui désigne un élément dans le HTML d’une
              page. Par exemple, <code>h2</code> désigne un titre, <code>.description</code> un
              élément avec la classe « description » et <code>#connexion</code> un élément dont
              l’identifiant est « connexion ».
            </p>
            <h3>La méthode dans Chrome ou Edge</h3>
            <Steps>
              <li>
                <strong>Ouvrez la page à analyser.</strong> Choisissez une page qui montre
                réellement les articles. Fermez les fenêtres de consentement qui recouvrent le
                contenu si nécessaire.
              </li>
              <li>
                <strong>Inspectez un titre.</strong> Faites un clic droit sur le titre d’un article,
                puis <b>Inspecter</b>. Raccourci : <kbd>Ctrl</kbd> + <kbd>Maj</kbd> + <kbd>C</kbd>{" "}
                sur Windows, ou <kbd>⌘</kbd> + <kbd>⌥</kbd> + <kbd>C</kbd> sur Mac, puis cliquez sur
                l’élément.
              </li>
              <li>
                <strong>Lisez la ligne sélectionnée dans Elements / Éléments.</strong> Si vous voyez{" "}
                <code>&lt;a class="title" href="…"&gt;</code>, le sélecteur <code>a.title</code>{" "}
                cible ce lien. Le point indique une classe ; les mots de la classe ne doivent pas
                contenir d’espaces dans le sélecteur.
              </li>
              <li>
                <strong>Remontez au bloc commun.</strong> Dans l’arbre HTML, cherchez le parent qui
                contient le titre, le lien, la description et la date d’un seul article. S’il s’agit
                de <code>&lt;article class="article-card"&gt;</code>, le sélecteur des articles peut
                être <code>article.article-card</code>.
              </li>
              <li>
                <strong>Vérifiez la répétition.</strong> Dans le panneau Elements, utilisez{" "}
                <kbd>Ctrl</kbd> + <kbd>F</kbd> (ou <kbd>⌘</kbd> + <kbd>F</kbd>), puis saisissez
                votre sélecteur des articles. Plusieurs résultats doivent correspondre aux cartes,
                sans sélectionner le menu ou les publicités.
              </li>
              <li>
                <strong>Relevez les éléments internes.</strong> Pour le titre, le lien, la
                description et la date, préférez des sélecteurs courts relatifs au bloc article.
                Testez ensuite le tout dans DailyBrief.
              </li>
            </Steps>
            <Tip title="Copier un sélecteur peut aider, mais vérifiez-le">
              <p>
                Dans l’inspecteur : clic droit sur une ligne HTML → Copy / Copier → Copy selector /
                Copier le sélecteur. Le résultat contient parfois une longue suite de parents et de{" "}
                <code>:nth-child(…)</code>, fragile si l’ordre change. Préférez une classe stable ou
                un attribut descriptif, puis vérifiez plusieurs articles.
              </p>
            </Tip>
            <SelectorPlayground />
            <h3>Les expressions à reconnaître</h3>
            <Table
              headings={["Sélecteur", "Signification", "Usage courant"]}
              rows={[
                [<code>article</code>, "Toutes les balises article", "Bloc d’un article"],
                [<code>.article-card</code>, "Les éléments ayant cette classe", "Cartes répétées"],
                [
                  <code>#login-email</code>,
                  "L’élément avec cet identifiant précis",
                  "Champ de formulaire unique",
                ],
                [<code>h2 a</code>, "Un lien à l’intérieur d’un titre h2", "Lien de lecture"],
                [
                  <code>a.accessToPrimaryDoc.primarydoc</code>,
                  "Un lien ayant ces deux classes à la fois",
                  "Lien d’une notice INP",
                ],
                [
                  <code>input[type='email']</code>,
                  "Un champ input de type email",
                  "Identifiant de connexion",
                ],
                [
                  <code>button[type='submit']</code>,
                  "Un bouton de soumission",
                  "Connexion à un journal",
                ],
              ]}
            />
            <p>
              Sur la rubrique Cloud du Monde Informatique, le HTML peut par exemple contenir des
              blocs <code>.list-large article.item</code>, un titre <code>h2</code>, un lien{" "}
              <code>h2 a.title</code>, une description <code>p.hidden-xs</code> et une date{" "}
              <code>span.theme b</code>. Ces exemples correspondent à une structure observée ; un
              site peut la modifier. Vérifiez toujours la page et l’aperçu actuels.
            </p>
          </Chapter>
          <Chapter id="assistance-ia" number="05" title="L’IA peut vous donner un coup de pouce">
            <p>
              Le bouton <b>Remplir avec l’IA</b> est disponible pour les sources de scraping, les
              liens intermédiaires RSS et les formulaires de connexion aux journaux. Il propose des
              réglages à partir de la page publique ouverte dans le navigateur du serveur.
            </p>
            <Steps>
              <li>
                Renseignez d’abord l’URL. Pour le scraping : la page qui liste les articles. Pour un
                RSS : l’URL du flux. Pour un journal : l’URL du formulaire de connexion.
              </li>
              <li>
                Cliquez sur <b>Remplir avec l’IA</b> et attendez la fin de l’analyse. Vous pouvez
                utiliser <b>Annuler l’analyse</b> pour revenir aux réglages.
              </li>
              <li>
                Vérifiez les champs remplis. L’IA propose une configuration ; elle ne remplace pas
                la vérification de l’aperçu.
              </li>
              <li>
                Pour une source, cliquez sur <b>Tester</b>. Pour un journal, complétez notamment le
                sélecteur de réussite, enregistrez puis utilisez <b>Tester la connexion</b>.
              </li>
            </Steps>
            <h3>Si l’analyse échoue ou reste incomplète</h3>
            <p>
              Lorsqu’une demande d’aide est disponible après l’échec, un bouton{" "}
              <b>Envoyer une demande d’aide</b> apparaît. En cliquant dessus, vous envoyez un email
              à l’administrateur configuré pour votre instance. Cet email indique le site concerné
              et les sélecteurs à trouver.
            </p>
            <Screenshot
              name="assistance"
              height={760}
              alt="Analyse IA incomplète avec message et bouton Envoyer une demande d’aide"
              caption="Une proposition peut être ajustée à la main ; une demande d’aide est proposée quand l’analyse rencontre un problème."
            />
            <Tip title="Vos identifiants restent hors de l’analyse">
              <p>
                Aucun identifiant de journal n’est envoyé à l’IA ni dans la demande d’aide.
                L’analyse se limite à la page publique. Un blocage du site, une page nécessitant une
                connexion ou un modèle IA indisponible peuvent empêcher l’analyse.
              </p>
            </Tip>
          </Chapter>
          <Chapter id="journaux" number="06" title="Activer les journaux et configurer leur accès">
            <p>
              La page <Link to="/journals">Journaux</Link> regroupe les domaines découverts dans les
              RSS avec sélecteur. Vous pouvez également ajouter un domaine manuellement, le modifier
              ou le supprimer. Les réglages sont propres à votre compte et réutilisés entre vos
              sources.
            </p>
            <Steps>
              <li>
                Repérez le domaine du journal, par exemple <code>www.lemonde.fr</code>. Les comptes
                concernent les aperçus recensés, pas le total historique de tous les articles en
                base.
              </li>
              <li>
                <strong>Activez le journal.</strong> Les nouveaux domaines sont désactivés par
                défaut. Le point vert indique un domaine actif et le point rouge un domaine
                désactivé. Un journal public peut être activé sans identifiants.
              </li>
              <li>
                Si un abonnement est nécessaire, utilisez l’icône en forme de clé{" "}
                <b>Configurer l’accès</b>. Elle devient disponible après activation.
              </li>
              <li>
                Renseignez l’email et le mot de passe de votre compte sur ce journal. Pour permettre
                la connexion automatique, renseignez aussi le formulaire et ses sélecteurs, puis
                enregistrez.
              </li>
              <li>
                Rouvrez la configuration et cliquez sur <b>Tester la connexion</b>. Un accès
                configuré ne prouve pas encore que la session fonctionne.
              </li>
            </Steps>
            <Screenshot
              name="journaux"
              height={410}
              alt="Tableau des journaux avec comptes, états d’activation, accès et actions"
              caption="Les actions permettent de configurer l’accès, modifier le domaine ou supprimer le journal."
            />
            <Table
              headings={["Réglage de connexion", "Exemple fictif", "Comment le choisir"]}
              rows={[
                [
                  "URL du formulaire",
                  <code>https://journal.exemple/connexion</code>,
                  "La page HTTPS où se trouvent les champs de connexion",
                ],
                [
                  "Sélecteur du champ email",
                  <code>input[type='email']</code>,
                  "Le champ où vous saisissez votre identifiant",
                ],
                [
                  "Sélecteur du champ mot de passe",
                  <code>input[type='password']</code>,
                  "Le champ du mot de passe",
                ],
                [
                  "Sélecteur du bouton de connexion",
                  <code>button[type='submit']</code>,
                  "Le bouton qui valide le formulaire",
                ],
                [
                  "Sélecteur visible après connexion",
                  <code>.mon-compte</code>,
                  "Un élément absent avant connexion et visible uniquement une fois connecté",
                ],
                [
                  "Sélecteur du contenu intégral",
                  <code>.article-body</code>,
                  "La zone du texte complet d’un article abonné, pour éviter un simple extrait public",
                ],
              ]}
            />
            <p>
              Pour trouver le sélecteur de réussite, connectez-vous vous-même au journal dans votre
              navigateur et inspectez un élément réservé à la session, comme le menu de votre
              compte. Un bouton « Se connecter » affiché en permanence ne convient pas.
            </p>
            <Screenshot
              name="acces"
              width={670}
              height={1040}
              alt="Fenêtre de configuration d’un journal avec formulaire de connexion et sélecteurs"
              caption="Les sélecteurs dépendent du site. L’assistance IA analyse uniquement sa page publique de connexion."
            />
            <h3>Modifier ou supprimer les identifiants</h3>
            <p>
              Le mot de passe est chiffré côté serveur et n’est jamais renvoyé après enregistrement.
              À l’édition, laissez le champ vide pour conserver le secret existant ; saisissez un
              nouveau mot de passe pour le remplacer. <b>Supprimer les identifiants</b> demande
              confirmation et efface aussi la session conservée.
            </p>
            <p>
              Les hôtes <code>journal.fr</code> et <code>www.journal.fr</code> ont des
              configurations distinctes. Configurez le domaine exact du lien de l’article. Les
              sessions sont isolées par compte et par journal.
            </p>
            <Tip title="Tous les formulaires ne sont pas automatisables">
              <p>
                Un abonnement valide reste nécessaire. Les CAPTCHA et la double authentification ne
                sont pas automatisés. Certains systèmes externes ou formulaires particuliers
                nécessitent une adaptation. Si le test échoue, vérifiez les sélecteurs et le message
                ; ne considérez pas un extrait public comme le texte complet d’un article réservé.
              </p>
            </Tip>
          </Chapter>
          <Chapter id="workflow" number="07" title="Tester le workflow de A à Z">
            <p>
              Dans <b>Sources</b>, utilisez l’icône de test portant l’infobulle{" "}
              <b>Tester le workflow de A à Z</b>. Ce parcours permet d’examiner les articles
              récupérés et de tester leur résumé à partir de la page complète.
            </p>
            <Steps>
              <li>
                Attendez la récupération de l’aperçu. Les articles déjà traités restent visibles.
              </li>
              <li>
                Pour un RSS avec sélecteur, vérifiez le tableau des journaux avant de lancer un
                résumé. Il est trié par nombre d’articles décroissant puis par domaine. Un item
                compte une seule fois.
              </li>
              <li>
                Consultez les erreurs de notices séparément. Une résolution échouée ne supprime pas
                les résultats réussis.
              </li>
              <li>
                Activez le domaine voulu si nécessaire, puis lancez le test du résumé sur un article
                accessible.
              </li>
              <li>
                Comparez le contenu récupéré, le résumé et ses points clés. Le lien de lecture doit
                mener à l’article externe.
              </li>
            </Steps>
            <Tip title="Un test, sans envoi de newsletter">
              <p>
                Le workflow n’envoie aucun email et ne modifie pas les articles, résumés ou
                newsletters existants. Il peut enregistrer les nouveaux domaines découverts et les
                réglages de journaux que vous modifiez. L’aperçu est disponible pendant 30 minutes ;
                utilisez Récupérer à nouveau les articles pour le renouveler.
              </p>
            </Tip>
          </Chapter>
          <Chapter id="collecte" number="08" title="Recevoir son brief et suivre la progression">
            <h3>À la demande</h3>
            <p>
              Sur le <Link to="/dashboard">Tableau de bord</Link>, cliquez sur{" "}
              <b>Récupérer maintenant</b>. La collecte continue côté serveur et la bannière{" "}
              <b>Récupération en cours</b> affiche la progression. Vous pouvez changer de page ou la
              recharger puis retrouver le suivi.
            </p>
            <h3>Chaque jour</h3>
            <Steps>
              <li>
                Dans <b>Collecte automatique</b>, activez <b>Récupération automatique</b>.
              </li>
              <li>
                Choisissez l’heure quotidienne et le fuseau horaire, par exemple{" "}
                <code>Europe/Paris</code>.
              </li>
              <li>
                Cliquez sur <b>Enregistrer les réglages</b>. Le bouton reste désactivé tant qu’aucun
                réglage n’a changé.
              </li>
              <li>
                Vérifiez la prochaine collecte affichée. Vous pouvez désactiver la programmation
                tout en conservant la récupération manuelle.
              </li>
            </Steps>
            <Screenshot
              name="dashboard"
              alt="Tableau de bord montrant l’heure quotidienne, le fuseau et la collecte manuelle"
              caption="Programmez l’heure qui vous convient ou déclenchez un brief immédiatement."
            />
            <h3>Le détail dans Jobs</h3>
            <p>
              La page <Link to="/jobs">Jobs</Link> affiche les dernières récupérations de votre
              compte. Sélectionnez une récupération pour voir les articles, leurs étapes et les
              tentatives. Pendant le recensement, le nombre total n’est pas encore connu. Il est
              fixé quand les articles à traiter ont été identifiés.
            </p>
            <p>
              Chaque article à traiter correspond à un job de récupération du contenu et de résumé
              IA. Si deux sources apportent 10 et 5 articles distincts à traiter, la collecte
              comporte 15 jobs. Les doublons et les résumés déjà disponibles peuvent réduire le
              nombre de nouveaux travaux.
            </p>
            <Screenshot
              name="jobs"
              height={720}
              alt="Progression d’une récupération et tableau de jobs terminés, en cours et en attente"
              caption="La progression et les états des articles restent consultables après rechargement."
            />
            <Table
              headings={["État", "Ce qu’il signifie"]}
              rows={[
                ["En attente", "L’article attend son tour."],
                ["En cours", "Le contenu ou le résumé est en traitement."],
                [
                  "Nouvelle tentative prévue",
                  "Une erreur temporaire a déclenché une nouvelle tentative.",
                ],
                ["Terminé", "Le travail est terminé ; vérifiez aussi s’il a été ignoré."],
                ["Échec", "Consultez le message et corrigez la source ou l’accès si nécessaire."],
              ]}
            />
            <p>
              Les articles de domaines désactivés sont ignorés pour l’extraction complète, l’IA et
              la newsletter. Les articles déjà envoyés ne sont pas inclus dans le prochain brief.
              S’il n’y a aucun nouvel article à envoyer, DailyBrief affiche ce résultat et n’envoie
              pas de newsletter vide.
            </p>
          </Chapter>
          <Chapter id="depannage" number="09" title="Quand quelque chose ne fonctionne pas">
            {[
              [
                "Aucun article n’apparaît",
                "Vérifiez que l’URL correspond au flux RSS ou à la liste d’articles. Pour le scraping, contrôlez le bloc racine et les quatre sélecteurs internes, puis le mode de chargement. Testez plusieurs cartes dans l’inspecteur.",
              ],
              [
                "Le site est accessible chez moi, mais DailyBrief reçoit un HTTP 403",
                "Le navigateur du serveur utilise une adresse réseau et une session différentes des vôtres. Un site peut autoriser votre navigateur et refuser la récupération automatisée. L’IA ne peut pas analyser une page refusée. Vérifiez l’URL et utilisez la demande d’aide lorsqu’elle est proposée.",
              ],
              [
                "L’IA ne répond pas ou l’analyse est lente",
                "Vous pouvez annuler l’analyse et renseigner les sélecteurs manuellement. La durée dépend du modèle configuré, du matériel et de la page. Si le modèle est indisponible, contactez l’administrateur de votre instance.",
              ],
              [
                "La collecte reste en attente",
                "Consultez Jobs pour distinguer une attente de traitement d’un échec. Si aucun job ne démarre durablement, demandez à l’administrateur de vérifier Redis et le processus worker de l’instance.",
              ],
              [
                "Je n’ai pas reçu de newsletter",
                "Vérifiez le résultat de la collecte dans Jobs, les sources actives, les journaux activés et votre dossier spam. « Aucun nouvel article à envoyer » signifie qu’aucun email n’était prévu. Une erreur d’envoi doit être vérifiée avec l’administrateur.",
              ],
              [
                "La connexion au journal échoue",
                "Enregistrez les réglages avant le test. Contrôlez l’URL HTTPS, les champs, le bouton et l’élément visible uniquement après connexion. Un CAPTCHA, une double authentification ou une session expirée peut demander une action supplémentaire.",
              ],
            ].map(([title, text]) => (
              <details className="doc-troubleshoot" key={title}>
                <summary>{title}</summary>
                <p>{text}</p>
              </details>
            ))}
          </Chapter>
          <Chapter id="glossaire" number="10" title="Le petit lexique">
            <dl className="doc-glossary">
              {[
                ["Source", "Un flux RSS ou une page web dont vous souhaitez suivre les articles."],
                ["RSS", "Un format de flux qui publie une liste d’articles et leurs informations."],
                [
                  "Scraping",
                  "La récupération d’informations depuis une page web à l’aide de sélecteurs.",
                ],
                ["Sélecteur CSS", "Une expression qui désigne un ou plusieurs éléments du HTML."],
                [
                  "Notice intermédiaire",
                  "Une page entre l’item RSS et l’article final, contenant son lien de lecture.",
                ],
                ["Domaine / journal", "L’hôte du lien final, par exemple www.lemonde.fr."],
                [
                  "Job / worker",
                  "Une tâche persistante et le processus serveur qui la traite en arrière-plan.",
                ],
                [
                  "Workflow",
                  "Un parcours de test pour vérifier les articles et leurs résumés avant la collecte réelle.",
                ],
              ].map(([term, description]) => (
                <div key={term}>
                  <dt>{term}</dt>
                  <dd>{description}</dd>
                </div>
              ))}
            </dl>
          </Chapter>
          <div className="doc-final">
            <BookOpen size={28} aria-hidden="true" />
            <h2>Prêt pour votre première source ?</h2>
            <p>
              Commencez par un seul flux et vérifiez son aperçu. Votre veille grandira avec votre
              curiosité.
            </p>
            <Link to="/sources" className="public-button">
              Ouvrir mes sources <ArrowUpRight size={17} aria-hidden="true" />
            </Link>
            <a href="#contenu" className="public-text-link">
              Revenir au début du guide ↑
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
