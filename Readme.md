## Deploy functions and firestore rules

`cd functions`

`npm run build`

`cd ..`

`firebase deploy --only functions --project orphancare-93b41`

`firebase deploy --only firestore:rules --project orphancare-93b41`

## Bootstrap Users

`gcloud auth application-default login`

`gcloud config set project orphancare-93b41`

`npx ts-node bootstrapUsers.ts`
