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
 *   Tous les seuils sont des paramètres de calibration PROVISOIRES.
 *
 * Utilisable dans le navigateur (globalThis.CapturAirMoteur) et sous Node (module.exports).
 */
(function (racine) {
  'use strict';

  const VERSION = 'P3b';

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
        nbSignificatifs: 0, nbIncertains: 0, nbBruitProbable: 0,
        incertainMaxM: 0,
        pics: [...pics.values()],
        excursions,
        suspects: [],
        evaluations: []
      };
      let ancre = null;
      chaine.forEach(P => {
        if (pics.has(P) || dansExcursion.has(P)) return;
        if (!ancre) { ancre = P; return; }
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
          if (ev.vitesseMoyenneEntreObservationsKmh != null && ev.vitesseMoyenneEntreObservationsKmh > params.seuilVitesseSuspecteKmH)
            r.suspects.push(ev);   // signalé, conservé dans le cumul
          ancre = P;
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

  const API = Object.freeze({
    VERSION, PARAMETRES, parametres,
    calculerDistance, precisionEffective, construireSegments, detecterTrous, calculerDistanceBrute,
    detecterPics: (chaine, surcharges) => [...detecterPics(chaine, parametres(surcharges)).values()],
    detecterExcursions: (chaine, surcharges) => detecterExcursions(chaine, parametres(surcharges)),
    calculerDistanceObservee
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  racine.CapturAirMoteur = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
