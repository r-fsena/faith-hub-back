import * as broadcasts from './broadcasts';
import * as studies from './studies';
import * as posts from './posts';
import * as uploads from './uploads';
import * as partilhas from './partilhas';
import * as devotionals from './devotionals';
import * as prayers from './prayers';
import * as contentAnalytics from './contentAnalytics';
import { createDomainApiHandler, DomainRouteMap } from './domainApiRouter';

export const contentApiRoutes: DomainRouteMap = {
  'POST /BROADCASTS': broadcasts.createOrUpdateBroadcast,
  'GET /BROADCASTS': broadcasts.getBroadcasts,
  'GET /BROADCASTS/ACTIVE': broadcasts.getActiveBroadcast,
  'DELETE /BROADCASTS/{ID}': broadcasts.deleteBroadcast,
  'GET /STUDIES': studies.getStudies,
  'POST /STUDIES': studies.createOrUpdateStudy,
  'DELETE /STUDIES/{ID}': studies.deleteStudy,
  'GET /STUDY-BOOKS': studies.getStudyBooks,
  'GET /STUDY-BOOKS/{ID}': studies.getStudyBookById,
  'POST /STUDY-BOOKS': studies.createOrUpdateStudyBook,
  'DELETE /STUDY-BOOKS/{ID}': studies.deleteStudyBook,
  'POST /STUDY-BOOKS/{ID}/CHAPTERS': studies.saveStudyChapter,
  'DELETE /STUDY-BOOKS/{ID}/CHAPTERS/{CHAPTERID}': studies.deleteStudyChapter,
  'POST /STUDY-CHAPTERS/{ID}/TOGGLE-COMPLETION': studies.toggleChapterCompletion,
  'GET /POSTS': posts.getPosts,
  'POST /POSTS': posts.createPost,
  'DELETE /POSTS/{ID}': posts.deletePost,
  'POST /POSTS/{ID}/REACT': posts.reactPost,
  'GET /UPLOAD-URL': uploads.getUploadUrl,
  'GET /PARTILHAS': partilhas.getPartilhas,
  'POST /PARTILHAS': partilhas.createPartilha,
  'PUT /PARTILHAS/{ID}/TOGGLE': partilhas.togglePartilha,
  'DELETE /PARTILHAS/{ID}': partilhas.deletePartilha,
  'GET /DEVOTIONALS': devotionals.getDevotionals,
  'GET /DEVOTIONALS/TODAY': devotionals.getTodayDevotional,
  'POST /DEVOTIONALS': devotionals.createOrUpdateDevotional,
  'DELETE /DEVOTIONALS/{ID}': devotionals.deleteDevotional,
  'POST /DEVOTIONALS/NOTES': devotionals.saveUserNote,
  'GET /PRAYERS': prayers.getPrayers,
  'POST /PRAYERS': prayers.createPrayer,
  'POST /PRAYERS/{ID}/PRAY': prayers.prayForRequest,
  'DELETE /PRAYERS/{ID}': prayers.deletePrayer,
  'POST /PRAYERS/{ID}/RESPOND': prayers.respondPrayerPastoral,
  'POST /PRAYERS/{ID}/TESTIMONY': prayers.submitTestimony,
  'PATCH /PRAYERS/{ID}/STATUS': prayers.updatePrayerStatus,
  'POST /CONTENT/ENGAGEMENT': contentAnalytics.trackContentEngagement,
  'GET /CONTENT/ANALYTICS': contentAnalytics.getContentAnalytics
};

export const contentApiHandler = createDomainApiHandler(contentApiRoutes);
