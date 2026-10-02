/*
 * CapturAir — position-moteur.js
 * Moteur pur de calcul sur les observations de position.
 *
 * Contrat (P1/P2) :
 *   - aucun DOM, aucune dépendance Google Maps, aucun appel réseau, aucun token, aucun accès D1 ou Home Assistant ;
 *   - reçoit des observations, retourne des résultats calculés ; ne modifie jamais les observations reçues ;
 *   - ne supprime aucune observation : une observation sans coordonnées valides est signalée, jamais effacée ;
 *   - ne classe AUCUN segment (bruit / incertain / significatif / suspect) : c'est le rôle de P3 ;
 *   - expose les faits nécessaires au diagnostic : distance géodésique, durée, précisions, vitesse moyenne
 *     entre observations, traversée d'une absence d'observations.
 *
 * Utilisable dans le navigateur (globalThis.CapturAirMoteur) et sous Node (module.exports).
 */
(function (racine) {
  'use strict';

  const VERSION = 'P2';

  // Paramètres de calibration : provisoires, centralisés, à ajuster sur les données réelles CapturAir.
  const PARAMETRES = Object.freeze({
    // Précision attribuée à une observation dont precision_m est absente, non numérique ou ≤ 0.
    // Chez CapturAir, precision_m = 0 (ex. RAV4) signifie « précision non disponible », jamais « 0 m ».
    precisionParDefautM: 30,
    // DS4 / B11 : écart au-delà duquel on parle d'absence d'observations (jamais de panne).
    seuilTrouMin: 30
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

  const API = Object.freeze({
    VERSION, PARAMETRES, parametres,
    calculerDistance, precisionEffective, construireSegments, detecterTrous, calculerDistanceBrute
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  racine.CapturAirMoteur = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
