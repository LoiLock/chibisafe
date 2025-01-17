const path = require('path');
const jetpack = require('fs-jetpack');
const multer = require('multer');
const moment = require('moment');
const Util = require('../../utils/Util');
const Route = require('../../structures/Route');

const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: parseInt(process.env.MAX_SIZE, 10) * (1000 * 1000),
		files: 1
	},
	fileFilter: (req, file, cb) =>
	// TODO: Enable blacklisting of files/extensions
		/*
		if (options.blacklist.mimes.includes(file.mimetype)) {
			return cb(new Error(`${file.mimetype} is a blacklisted filetype.`));
		} else if (options.blacklist.extensions.some(ext => path.extname(file.originalname).toLowerCase() === ext)) {
			return cb(new Error(`${path.extname(file.originalname).toLowerCase()} is a blacklisted extension.`));
		}
		*/
		cb(null, true)

}).array('files[]');

/*
	TODO: If source has transparency generate a png thumbnail, otherwise a jpg.
	TODO: If source is a gif, generate a thumb of the first frame and play the gif on hover on the frontend.

	TODO: Think if its worth making a folder with the user uuid in uploads/ and upload the pictures there so
			that this way at least not every single file will be in 1 directory

	XXX: Now that the default behaviour is to serve files with node, we can actually pull this off.
		 Before this, having files in subfolders meant messing with nginx and the paths,
		 but now it should be fairly easy to re-arrange the folder structure with express.static
		 I see great value in this, open to suggestions.
*/

class uploadPOST extends Route {
	constructor() {
		super('/upload', 'post', {
			bypassAuth: true,
			canApiKey: true
		});
	}

	async run(req, res, db) {
		const user = await Util.isAuthorized(req);
		if (!user && process.env.PUBLIC_MODE === 'false') return res.status(401).json({ message: 'Not authorized to use this resource' });

		const albumId = req.body.albumid || req.headers.albumid;
		if (albumId && !user) return res.status(401).json({ message: 'Only registered users can upload files to an album' });
		if (albumId && user) {
			const album = await db.table('albums').where({ id: albumId, userId: user.id }).first();
			if (!album) return res.status(401).json({ message: 'Album doesn\'t exist or it doesn\'t belong to the user' });
		}

		return upload(req, res, async err => {
			if (err) console.error(err.message);

			let uploadedFile = {};
			let insertedId;

			// eslint-disable-next-line no-underscore-dangle
			const remappedKeys = this._remapKeys(req.body);
			const file = req.files[0];

			const ext = path.extname(file.originalname);
			const hash = Util.generateFileHash(file.buffer);

			const filename = Util.getUniqueFilename(file.originalname);

			/*
				First let's get the hash of the file. This will be useful to check if the file
				has already been upload by either the user or an anonymous user.
				In case this is true, instead of uploading it again we retrieve the url
				of the file that is already saved and thus don't store extra copies of the same file.

				For this we need to wait until we have a filename so that we can delete the uploaded file.
			*/
			const exists = await Util.checkIfFileExists(db, user, hash);
			if (exists) return this.fileExists(res, exists, filename);

			if (remappedKeys && remappedKeys.uuid) {
				const chunkOutput = path.join(__dirname,
					'../../../../',
					process.env.UPLOAD_FOLDER,
					'chunks',
					remappedKeys.uuid,
					`${remappedKeys.chunkindex.padStart(3, 0)}${ext || ''}`);
				await jetpack.writeAsync(chunkOutput, file.buffer);
			} else {
				const output = path.join(__dirname,
					'../../../../',
					process.env.UPLOAD_FOLDER,
					filename);
				await jetpack.writeAsync(output, file.buffer);
				uploadedFile = {
					name: filename,
					hash,
					size: file.buffer.length,
					url: filename
				};
			}

			if (!remappedKeys || !remappedKeys.uuid) {
				Util.generateThumbnails(uploadedFile.name);
				insertedId = await Util.saveFileToDatabase(req, res, user, db, uploadedFile, file);
				if (!insertedId) return res.status(500).json({ message: 'There was an error saving the file.' });
				uploadedFile.deleteUrl = `${process.env.DOMAIN}/api/file/${insertedId[0]}`;

				/*
					If the upload had an album specified we make sure to create the relation
					and update the according timestamps..
				*/
				Util.saveFileToAlbum(db, albumId, insertedId);
			}

			uploadedFile = Util.constructFilePublicLink(uploadedFile);
			return res.status(201).send({
				message: 'Sucessfully uploaded the file.',
				...uploadedFile
			});
		});
	}

	fileExists(res, exists, filename) {
		exists = Util.constructFilePublicLink(exists);
		res.json({
			message: 'Successfully uploaded the file.',
			name: exists.name,
			hash: exists.hash,
			size: exists.size,
			url: `${process.env.DOMAIN}/${exists.name}`,
			deleteUrl: `${process.env.DOMAIN}/api/file/${exists.id}`,
			repeated: true
		});

		return Util.deleteFile(filename);
	}

	_remapKeys(body) {
		const keys = Object.keys(body);
		if (keys.length) {
			for (const key of keys) {
				if (!/^dz/.test(key)) continue;
				body[key.replace(/^dz/, '')] = body[key];
				delete body[key];
			}
			return body;
		}
	}
}

module.exports = uploadPOST;
