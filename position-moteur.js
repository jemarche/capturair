/*
 * CapturAir — position-moteur.js
 * Moteur pur de calcul sur les observations de position.
 *
 * Contrat (P1/P2, inchangé en P3) :
 *   - aucun DOM, aucune dépendance Google Maps, aucun appel réseau, aucun token, aucun accès D1 ou Home Assistant ;
 *   - reçoit des observations, retourne des résultats calculés ; ne modifie jamais les observations reçues ;
 *   - ne supprime aucune observation : une observation sans coordonnées valides est signalée, jamais effacée ;
 *   - construireSegments / calculerDistanceBrute ne classent AUCUN segment ;
 *   - expose les faits nécessaires au diagnostic : distance géodésique, durée, précisions, vitesse moyenne
 *     entre observations, traversée d'une absence d'observations.
 *
 * P3 (calculerDistanceObservee) :
 *   - première étape autorisée à classer (bruit_probable / incertain / significatif) et à écarter des pics ;
 *   - n'écarte que du CUMUL : aucune observation n'est modifiée ni supprimée ; tout est rapporté au diagnostic ;
 *   - orthogonal à B11 : une absence d'observations n'invalide jamais la distance entre ses deux extrémités ;
 *   - un segment très rapide (> seuilVitesseSuspecteKmH) est SIGNALÉ, jamais supprimé ;
 *   - P3b : une excursion groupée (fantôme) n'est écartée que comme un ensemble, et toujours listée.
 *
 * P4 : expose, sur les SEULS segments retenus (significatifs), la part traversant une absence
 *   d'observations et la part partant du point de contexte.
 *   P4.1 : un segment retenu (ancre → point) traverse une absence SI ET SEULEMENT SI, entre l'ancre et le
 *   point, deux observations SUCCESSIVES de l'appareil sont espacées de plus de seuilTrouMin (définition B11).
 *   Toutes les observations intermédiaires comptent, y compris bruit, incertain, pics et excursions écartés.
 *   La durée ancre → point n'est PAS un critère d'absence.
 *
 * B10b (agregerDensite) : représentation INTERPRÉTATIVE. Regroupe les observations en cellules d'une grille
 *   stable (alignée sur une origine fixe). Exclut uniquement les observations identifiées comme pics P3 ou
 *   membres d'une excursion fantôme P3b ; les observations bruit_probable / incertain restent comptées.
 *   Le point de contexte sert à cette détection mais n'est JAMAIS compté dans une cellule.
 *   Densité d'observations ≠ temps passé (la déduplication n'enregistre presque rien d'un appareil immobile).
 *
 * A0 (validerConfiguration) : vérifie position-config.json (valeurs seulement, aucune logique). Schéma strict,
 *   révision libre. Une configuration invalide est REFUSÉE : jamais de valeur par défaut silencieuse. Le point de contexte (dernière observation
 *   strictement antérieure à la période) n'est jamais compté comme observation de la période :
 *   il sert uniquement d'origine au premier segment, qui appartient à la période de son point d'arrivée.
 *   Tous les seuils sont des paramètres de calibration PROVISOIRES.
 *
 * Utilisable dans le navigateur (globalThis.CapturAirMoteur) et sous Node (module.exports).
 */
(function (racine) {
  'use strict';

  const VERSION = 'A0';
  const SCHEMA_CONFIG = 1;   // A0 — contrat de structure de position-config.json

  // Paramètres de calibration : provisoires, centralisés, à ajuster sur les données réelles CapturAir.
  const PARAMETRES = Object.freeze({
    // Précision attribuée à une observation dont precision_m est absente, non numérique ou ≤ 0.
    // Chez CapturAir, precision_m = 0 (ex. RAV4) signifie « précision non disponible », jamais « 0 m ».
    precisionParDefautM: 30,
    // DS4 / B11 : écart au-delà duquel on parle d'absence d'observations (jamais de panne).
    seuilTrouMin: 30,
    // P3 — calibrés sur le jeu terrain du 2 octobre 2026 (5 appareils). Provisoires, à recalibrer.
    facteurSignificatif: 3,          // significatif si distance > facteur × (précision A + précision B)
    facteurPic: 4,                   // pic si l'écart vers X ≤ facteur × (précision voisin + précision X)
    seuilGrandeVitesseKmH: 300,      // pic à grande vitesse : aller ET retour au-delà, retour près du départ
    seuilVitesseSuspecteKmH: 1000,   // au-delà : segment suspect, signalé, jamais supprimé
    // P3b — excursion groupée A → X₁…Xₙ → B (fantôme Find Hub). Provisoires, à recalibrer.
    facteurDegradationPrecision: 4,  // chaque Xᵢ au moins 4 × moins précis que la MEILLEURE des extrémités A, B
    rayonRetourM: 100,               // A et B « proches » si d(A,B) ≤ max(pA + pB, rayonRetourM)
    facteurPorteeExcursion: 15       // écart max. ≤ 15 × précision du point le plus éloigné (sinon : vrai trajet)
  });

  const RAYON_TERRE_M = 6371008.8;   // rayon terrestre moyen (UGGI)

  function parametres(surcharges) {
    return Object.assign({}, PARAMETRES, surcharges || {});
  }

  // Distance géodésique (formule de haversine), en mètres.
  function calculerDistance(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * RAYON_TERRE_M * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Précision effective d'une observation : { m, inconnue }.
  function precisionEffective(precision, params) {
    const p = params || PARAMETRES;
    const v = Number(precision);
    return Number.isFinite(v) && v > 0 ? { m: v, inconnue: false } : { m: p.precisionParDefautM, inconnue: true };
  }

  function coordonneesValides(o) {
    return o && Number.isFinite(o.latitude) && Number.isFinite(o.longitude)
      && Math.abs(o.latitude) <= 90 && Math.abs(o.longitude) <= 180
      && Number.isFinite(Date.parse(o.observed_at));
  }

  // Partition par appareil AVANT toute construction de segments, tri chronologique stable par appareil.
  // Retourne { parAppareil: Map<id, observations[]>, ignorees: [{ observation, raison }] }.
  function partitionner(observations) {
    const parAppareil = new Map(), ignorees = [];
    (observations || []).forEach((o, rang) => {
      if (!coordonneesValides(o)) { ignorees.push({ observation: o, raison: 'coordonnées ou horodatage invalides' }); return; }
      if (!parAppareil.has(o.appareil_id)) parAppareil.set(o.appareil_id, []);
      parAppareil.get(o.appareil_id).push({ o, rang });
    });
    parAppareil.forEach((liste, id) => {
      liste.sort((a, b) => Date.parse(a.o.observed_at) - Date.parse(b.o.observed_at) || a.rang - b.rang);
      parAppareil.set(id, liste.map(x => x.o));
    });
    return { parAppareil, ignorees };
  }

  // Segments chronologiques par appareil. Jamais de segment entre deux appareils différents.
  // options.contexte : observations antérieures à la période (au plus une utile par appareil : la plus récente).
  // Un segment partant du point de contexte est marqué depuisContexte (il appartient à la période de son arrivée).
  function construireSegments(observations, options) {
    const opt = options || {};
    const params = parametres(opt.parametres);
    const seuilTrouMs = params.seuilTrouMin * 60000;
    const { parAppareil, ignorees } = partitionner(observations);
    const contexte = partitionner(opt.contexte || []).parAppareil;
    const segments = [];

    parAppareil.forEach((obs, id) => {
      const ctx = contexte.get(id);
      const premier = Date.parse(obs[0].observed_at);
      const avant = ctx ? ctx.filter(c => Date.parse(c.observed_at) < premier).pop() : null;
      const chaine = avant ? [avant, ...obs] : obs;
      for (let k = 1; k < chaine.length; k++) {
        const a = chaine[k - 1], b = chaine[k];
        const ta = Date.parse(a.observed_at), tb = Date.parse(b.observed_at);
        const distanceM = calculerDistance(a.latitude, a.longitude, b.latitude, b.longitude);
        const dureeMs = tb - ta;
        const pa = precisionEffective(a.precision_m, params), pb = precisionEffective(b.precision_m, params);
        segments.push({
          appareil_id: id,
          depart: a,
          arrivee: b,
          debutMs: ta,
          finMs: tb,
          distanceM,
          dureeMs,
          precisionDepartM: pa.m,
          precisionArriveeM: pb.m,
          precisionDepartInconnue: pa.inconnue,
          precisionArriveeInconnue: pb.inconnue,
          sommePrecisionsM: pa.m + pb.m,
          // « vitesse moyenne entre observations » : géodésique, jamais une vitesse réelle instantanée
          vitesseMoyenneEntreObservationsKmh: dureeMs > 0 ? (distanceM / 1000) / (dureeMs / 3600000) : null,
          traverseAbsence: dureeMs > seuilTrouMs,
          depuisContexte: avant != null && k === 1
        });
      }
    });
    return { segments, ignorees };
  }

  // Absences d'observations (> seuil) entre observations successives d'un appareil (liste chronologique).
  // Rien avant la première ni après la dernière observation.
  function detecterTrous(observationsAppareil, surcharges) {
    const seuilMs = parametres(surcharges).seuilTrouMin * 60000;
    const liste = [];
    const obs = observationsAppareil || [];
    for (let k = 1; k < obs.length; k++) {
      const a = Date.parse(obs[k - 1].observed_at), b = Date.parse(obs[k].observed_at);
      if (b - a > seuilMs) liste.push({ debut: a, fin: b, duree: b - a });
    }
    return liste;
  }

  // P2 — Distance brute : somme de TOUS les segments, sans aucun filtrage ni classement.
  // Retourne un résumé par appareil, avec les informations nécessaires au diagnostic.
  function calculerDistanceBrute(observations, options) {
    const { segments, ignorees } = construireSegments(observations, options);
    const { parAppareil } = partitionner(observations);
    const resultats = new Map();
    parAppareil.forEach((obs, id) => resultats.set(id, {
      appareil_id: id,
      nbObservations: obs.length,
      nbSegments: 0,
      distanceBruteM: 0,
      distanceSurAbsencesM: 0,
      nbAbsences: 0,
      dureeCouverteMs: obs.length > 1 ? Date.parse(obs[obs.length - 1].observed_at) - Date.parse(obs[0].observed_at) : 0,
      nbPrecisionsInconnues: obs.filter(o => precisionEffective(o.precision_m).inconnue).length,
      vitesseMoyenneMaxKmh: null,
      segments: []
    }));
    segments.forEach(s => {
      const r = resultats.get(s.appareil_id);
      r.nbSegments++;
      r.distanceBruteM += s.distanceM;
      if (s.traverseAbsence) { r.nbAbsences++; r.distanceSurAbsencesM += s.distanceM; }
      if (s.vitesseMoyenneEntreObservationsKmh != null)
        r.vitesseMoyenneMaxKmh = Math.max(r.vitesseMoyenneMaxKmh || 0, s.vitesseMoyenneEntreObservationsKmh);
      r.segments.push(s);
    });
    return { appareils: [...resultats.values()], ignorees };
  }

  // ── P3 — Filtrage ────────────────────────────────────────────────────────────────────────────

  function kmh(distanceM, dureeMs) { return dureeMs > 0 ? (distanceM / 1000) / (dureeMs / 3600000) : null; }

  // Pics A → X → B : X est écarté du cumul (jamais de la base) si A et B sont proches et que
  //  - (précision) les deux écarts vers X s'expliquent par l'imprécision de X : ≤ facteurPic × (p voisin + p X) ;
  //  - ou (grande vitesse) aller et retour dépassent seuilGrandeVitesseKmH.
  // Les extrémités de la chaîne ne sont jamais des pics.
  function detecterPics(chaine, params) {
    const pics = new Map();
    for (let k = 1; k < chaine.length - 1; k++) {
      const A = chaine[k - 1], X = chaine[k], B = chaine[k + 1];
      const pA = precisionEffective(A.precision_m, params).m, pX = precisionEffective(X.precision_m, params).m;
      const pB = precisionEffective(B.precision_m, params).m;
      const dAB = calculerDistance(A.latitude, A.longitude, B.latitude, B.longitude);
      if (dAB > pA + pB) continue;   // A et B ne sont pas proches : pas un aller-retour
      const dAX = calculerDistance(A.latitude, A.longitude, X.latitude, X.longitude);
      const dXB = calculerDistance(X.latitude, X.longitude, B.latitude, B.longitude);
      if (dAX <= pA + pX && dXB <= pX + pB) continue;   // simple bruit, pas une excursion
      const tA = Date.parse(A.observed_at), tX = Date.parse(X.observed_at), tB = Date.parse(B.observed_at);
      const vAller = kmh(dAX, tX - tA), vRetour = kmh(dXB, tB - tX);
      if (dAX <= params.facteurPic * (pA + pX) && dXB <= params.facteurPic * (pX + pB)) {
        pics.set(X, { observation: X, type: 'precision', ecartM: Math.max(dAX, dXB), precisionM: pX, vitesseAllerKmh: vAller, vitesseRetourKmh: vRetour });
      } else if (vAller != null && vRetour != null && vAller > params.seuilGrandeVitesseKmH && vRetour > params.seuilGrandeVitesseKmH) {
        pics.set(X, { observation: X, type: 'grande_vitesse', ecartM: Math.max(dAX, dXB), precisionM: pX, vitesseAllerKmh: vAller, vitesseRetourKmh: vRetour });
      }
    }
    return pics;
  }

  // P3b — Excursions groupées A → X₁…Xₙ → B, analysées comme un ENSEMBLE.
  // B est le premier retour « proche » de A. L'excursion n'est écartée du cumul que si les 4 conditions sont réunies :
  //  1. retour près du départ : d(A,B) ≤ max(pA + pB, rayonRetourM) ;
  //  2. TOUS les Xᵢ au moins facteurDegradationPrecision fois moins précis que la meilleure des extrémités ;
  //  3. analyse en ensemble : un seul Xᵢ bien localisé suffit à CONSERVER toute l'excursion ;
  //  4. portée compatible avec l'imprécision : écart max. ≤ facteurPorteeExcursion × précision du point le plus éloigné.
  // (Et au moins un Xᵢ s'écarte de A au-delà de la tolérance, sinon ce n'est pas une excursion.)
  // Les pics déjà écartés (P3) ne sont pas réexaminés.
  function detecterExcursions(chaine, params) {
    const excursions = [];
    const prec = o => precisionEffective(o.precision_m, params).m;
    const dist = (u, v) => calculerDistance(u.latitude, u.longitude, v.latitude, v.longitude);
    let i = 0;
    while (i < chaine.length - 2) {
      const A = chaine[i], pA = prec(A);
      const proche = P => dist(A, P) <= Math.max(pA + prec(P), params.rayonRetourM);
      if (proche(chaine[i + 1])) { i++; continue; }   // pas de départ
      let j = i + 2;
      while (j < chaine.length && !proche(chaine[j])) j++;
      if (j >= chaine.length) { i++; continue; }      // aucun retour près de A
      const B = chaine[j], interm = chaine.slice(i + 1, j);
      const meilleure = Math.min(pA, prec(B));
      const toutesDegradees = interm.every(X => prec(X) >= params.facteurDegradationPrecision * meilleure);
      const ecartMaxM = Math.max(...interm.map(X => dist(A, X)));
      const plusEloigne = interm.find(X => dist(A, X) === ecartMaxM);
      const rapportPortee = ecartMaxM / prec(plusEloigne);
      const porteeCompatible = rapportPortee <= params.facteurPorteeExcursion;   // condition 4
      const sort = interm.some(X => dist(A, X) > pA + prec(X));
      if (toutesDegradees && porteeCompatible && sort) {
        excursions.push({
          depart: A, retour: B, points: interm, ecartMaxM,
          distanceRetourM: dist(A, B),
          precisionMeilleureExtremiteM: meilleure,
          precisionMinIntermediaireM: Math.min(...interm.map(prec)),
          seuilRetourM: Math.max(pA + prec(B), params.rayonRetourM),
          pointLePlusEloigne: plusEloigne,
          precisionPointLePlusEloigneM: prec(plusEloigne),
          rapportPortee,
          seuilPortee: params.facteurPorteeExcursion,
          raison: `${interm.length} point(s) au moins ${params.facteurDegradationPrecision} × moins précis que la meilleure extrémité (±${Math.round(meilleure)} m), retour à ${Math.round(dist(A, B))} m du départ, écart max. = ${rapportPortee.toFixed(1)} × la précision du point le plus éloigné (seuil ${params.facteurPorteeExcursion})`
        });
        i = j;   // l'analyse reprend au retour B
      } else {
        i++;
      }
    }
    return excursions;
  }

  // P3 — Distance observée filtrée (candidate), par appareil.
  // Chaque point (hors pics) est évalué depuis le DERNIER POINT RETENU (ancre) :
  //   distance ≤ tolérance                       → bruit_probable (l'ancre reste)
  //   ≤ facteurSignificatif × tolérance          → incertain      (l'ancre reste)
  //   > facteurSignificatif × tolérance          → significatif   (compté ; le point devient l'ancre)
  // tolérance = précision effective de l'ancre + précision effective du point.
  // Les absences d'observations (B11) n'interviennent PAS.
  function calculerDistanceObservee(observations, options) {
    const opt = options || {};
    const params = parametres(opt.parametres);
    const { parAppareil, ignorees } = partitionner(observations);
    const contexte = partitionner(opt.contexte || []).parAppareil;
    const brut = calculerDistanceBrute(observations, options).appareils;
    const resultats = [];

    parAppareil.forEach((obs, id) => {
      const ctx = contexte.get(id);
      const avant = ctx ? ctx.filter(c => Date.parse(c.observed_at) < Date.parse(obs[0].observed_at)).pop() : null;
      const chaine = avant ? [avant, ...obs] : obs;
      const pics = detecterPics(chaine, params);
      const excursions = detecterExcursions(chaine.filter(o => !pics.has(o)), params);   // P3b
      const dansExcursion = new Set(excursions.flatMap(e => e.points));
      const r = {
        appareil_id: id,
        distanceBruteM: (brut.find(b => b.appareil_id === id) || {}).distanceBruteM || 0,
        distanceFiltreeM: 0,
        // P4 — calculés uniquement sur les segments RETENUS
        distanceFiltreeSurAbsencesM: 0,
        nbRetenusSurAbsences: 0,
        contexte: avant || null,                // observation de contexte utilisée (jamais comptée dans la période)
        distanceDepuisContexteM: 0,             // part retenue partant du point de contexte
        nbSignificatifs: 0, nbIncertains: 0, nbBruitProbable: 0,
        incertainMaxM: 0,
        pics: [...pics.values()],
        excursions,
        suspects: [],
        evaluations: []
      };
      // P4.1 — écarts entre observations SUCCESSIVES de la chaîne complète (contexte compris, rien n'est filtré ici)
      const seuilTrouMs = params.seuilTrouMin * 60000;
      const absenceAvant = chaine.map((o, k) => k > 0 && Date.parse(o.observed_at) - Date.parse(chaine[k - 1].observed_at) > seuilTrouMs);
      let ancre = null, ancreIdx = -1;
      chaine.forEach((P, k) => {
        if (pics.has(P) || dansExcursion.has(P)) return;
        if (!ancre) { ancre = P; ancreIdx = k; return; }
        const pa = precisionEffective(ancre.precision_m, params).m, pp = precisionEffective(P.precision_m, params).m;
        const tolerance = pa + pp;
        const d = calculerDistance(ancre.latitude, ancre.longitude, P.latitude, P.longitude);
        const duree = Date.parse(P.observed_at) - Date.parse(ancre.observed_at);
        const classe = d <= tolerance ? 'bruit_probable' : d <= params.facteurSignificatif * tolerance ? 'incertain' : 'significatif';
        const ev = { classe, depart: ancre, arrivee: P, distanceM: d, toleranceM: tolerance, dureeMs: duree,
                     vitesseMoyenneEntreObservationsKmh: kmh(d, duree) };
        r.evaluations.push(ev);
        if (classe === 'significatif') {
          r.nbSignificatifs++;
          r.distanceFiltreeM += d;
          if (absenceAvant.slice(ancreIdx + 1, k + 1).some(Boolean)) { r.distanceFiltreeSurAbsencesM += d; r.nbRetenusSurAbsences++; }   // P4.1
          if (avant && ancre === avant) r.distanceDepuisContexteM += d;                                                // P4
          if (ev.vitesseMoyenneEntreObservationsKmh != null && ev.vitesseMoyenneEntreObservationsKmh > params.seuilVitesseSuspecteKmH)
            r.suspects.push(ev);   // signalé, conservé dans le cumul
          ancre = P; ancreIdx = k;
        } else if (classe === 'incertain') {
          r.nbIncertains++;
          r.incertainMaxM = Math.max(r.incertainMaxM, d);
        } else {
          r.nbBruitProbable++;
        }
      });
      resultats.push(r);
    });
    return { appareils: resultats, ignorees, parametres: params };
  }

  // ── B10b — Densité ──────────────────────────────────────────────────────────────────────────
  // options : { tailleCelluleM (obligatoire, > 0), latitudeReference (pour la largeur en longitude),
  //             contexte, parametres }. Retour : { cellules, nbComptees, nbExclues, exclues, maxParCellule }.
  function agregerDensite(observations, options) {
    const opt = options || {};
    const taille = Number(opt.tailleCelluleM);
    if (!(taille > 0)) throw new Error('agregerDensite : tailleCelluleM doit être > 0');
    const latRef = Number.isFinite(opt.latitudeReference) ? opt.latitudeReference : 45;
    const pasLat = taille / 111195;
    const pasLon = taille / (111195 * Math.max(0.01, Math.cos(latRef * Math.PI / 180)));
    // Observations écartées par P3 (pics) et P3b (excursions) — même analyse que la distance observée
    const filtre = calculerDistanceObservee(observations, { contexte: opt.contexte, parametres: opt.parametres });
    const exclues = new Map();
    filtre.appareils.forEach(a => {
      a.pics.forEach(p => exclues.set(p.observation, 'pic'));
      a.excursions.forEach(e => e.points.forEach(o => exclues.set(o, 'excursion')));
    });
    const cellules = new Map();
    let nbComptees = 0;
    (observations || []).forEach(o => {
      if (!coordonneesValides(o) || exclues.has(o)) return;
      const i = Math.floor(o.latitude / pasLat), j = Math.floor(o.longitude / pasLon);
      const cle = i + ':' + j;
      if (!cellules.has(cle)) cellules.set(cle, { i, j, sud: i * pasLat, nord: (i + 1) * pasLat, ouest: j * pasLon, est: (j + 1) * pasLon, n: 0, parAppareil: {} });
      const c = cellules.get(cle);
      c.n++;
      c.parAppareil[o.appareil_id] = (c.parAppareil[o.appareil_id] || 0) + 1;
      nbComptees++;
    });
    const liste = [...cellules.values()];
    const periode = new Set(observations || []);   // le contexte n'en fait pas partie
    const listeExclues = [...exclues.entries()].filter(([o]) => periode.has(o)).map(([observation, raison]) => ({ observation, raison }));
    return {
      cellules: liste,
      nbComptees,
      nbExclues: listeExclues.length,
      exclues: listeExclues,
      maxParCellule: liste.reduce((m, c) => Math.max(m, c.n), 0),
      tailleCelluleM: taille
    };
  }

  // ── A0 — Validation de la configuration ─────────────────────────────────────────────────────
  // Plages admissibles des paramètres de calcul (bornes de sécurité, pas des valeurs de calibration)
  const BORNES_PARAMETRES = Object.freeze({
    precisionParDefautM: [1, 1000], seuilTrouMin: [1, 1440], facteurSignificatif: [1, 20], facteurPic: [1, 20],
    seuilGrandeVitesseKmH: [50, 2000], seuilVitesseSuspecteKmH: [100, 5000], facteurDegradationPrecision: [1, 50],
    rayonRetourM: [1, 5000], facteurPorteeExcursion: [1, 100]
  });
  const estCouleur = v => typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v);
  const estTexte = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  function validerConfiguration(cfg) {
    const erreurs = [], avertissements = [];
    const objet = v => v && typeof v === 'object' && !Array.isArray(v);
    if (!objet(cfg)) return { ok: false, erreurs: ['configuration absente ou non lisible'], avertissements };
    if (cfg.SCHEMA !== SCHEMA_CONFIG) erreurs.push(`schéma ${JSON.stringify(cfg.SCHEMA)} ≠ schéma attendu ${SCHEMA_CONFIG}`);
    if (!estTexte(cfg.REVISION, 80)) erreurs.push('REVISION : texte non vide (80 caractères au plus) attendu');
    // Paramètres de calcul : tous présents, numériques, dans leurs bornes
    if (!objet(cfg.moteur)) erreurs.push('moteur : objet attendu');
    else {
      Object.keys(BORNES_PARAMETRES).forEach(k => {
        const v = cfg.moteur[k], [a, b] = BORNES_PARAMETRES[k];
        if (!(typeof v === 'number' && Number.isFinite(v))) erreurs.push(`moteur.${k} : nombre attendu`);
        else if (v < a || v > b) erreurs.push(`moteur.${k} = ${v} hors des bornes [${a} ; ${b}]`);
      });
      Object.keys(cfg.moteur).filter(k => !(k in BORNES_PARAMETRES)).forEach(k => avertissements.push(`moteur.${k} : paramètre inconnu, ignoré`));
    }
    if (!objet(cfg.contexte) || !(Number.isFinite(cfg.contexte.fenetreH) && cfg.contexte.fenetreH >= 1 && cfg.contexte.fenetreH <= 168))
      erreurs.push('contexte.fenetreH : nombre entre 1 et 168 attendu');
    // Identités visuelles
    if (!objet(cfg.appareils)) erreurs.push('appareils : objet attendu');
    else Object.entries(cfg.appareils).forEach(([id, a]) => {
      if (!objet(a) || !estCouleur(a.couleur) || !estTexte(a.emoji, 16)) erreurs.push(`appareils.${id} : { couleur: "#RRGGBB", emoji } attendu`);
    });
    if (!Array.isArray(cfg.couleursReserve) || !cfg.couleursReserve.length || !cfg.couleursReserve.every(estCouleur))
      erreurs.push('couleursReserve : liste non vide de couleurs "#RRGGBB" attendue');
    // Plages horaires
    if (!Array.isArray(cfg.plages) || !cfg.plages.length) erreurs.push('plages : liste non vide attendue');
    else {
      const ids = new Set();
      cfg.plages.forEach((p, k) => {
        const ok = objet(p) && typeof p.id === 'string' && /^[a-z0-9_-]+$/.test(p.id) && estTexte(p.nom, 40) && estTexte(p.emoji, 16) && estCouleur(p.couleur)
          && Number.isInteger(p.debut) && Number.isInteger(p.fin) && p.debut >= -1440 && p.fin <= 2880 && p.fin > p.debut;
        if (!ok) erreurs.push(`plages[${k}] : { id, nom, emoji, couleur, debut, fin (minutes, fin > debut) } attendu`);
        else if (ids.has(p.id)) erreurs.push(`plages : identifiant « ${p.id} » en double`);
        else ids.add(p.id);
      });
      if (!ids.has('journee')) erreurs.push('plages : la plage « journee » est obligatoire');
    }
    // Interrupteurs : booléens seulement (la page signale ceux qu'elle ne connaît pas)
    if (!objet(cfg.fonctions)) erreurs.push('fonctions : objet attendu');
    else Object.entries(cfg.fonctions).forEach(([k, v]) => { if (typeof v !== 'boolean') erreurs.push(`fonctions.${k} : true ou false attendu`); });
    const ok = erreurs.length === 0;
    return { ok, erreurs, avertissements, parametres: ok ? Object.freeze(parametres(cfg.moteur)) : null };
  }

  const API = Object.freeze({
    VERSION, PARAMETRES, parametres,
    calculerDistance, precisionEffective, construireSegments, detecterTrous, calculerDistanceBrute,
    detecterPics: (chaine, surcharges) => [...detecterPics(chaine, parametres(surcharges)).values()],
    detecterExcursions: (chaine, surcharges) => detecterExcursions(chaine, parametres(surcharges)),
    calculerDistanceObservee, agregerDensite,
    SCHEMA_CONFIG, BORNES_PARAMETRES, validerConfiguration
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  racine.CapturAirMoteur = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
