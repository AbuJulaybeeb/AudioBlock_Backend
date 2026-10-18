import { Request, Response } from 'express';
import { OEmbedService } from '../services/OEmbedService';
import { handleError } from '../utils/helpers';

const oembedService = new OEmbedService();

export class OEmbedController {
  static getOEmbed = async (req: Request, res: Response) => {
    try {
      const data = await oembedService.getOEmbed({
        url: typeof req.query.url === 'string' ? req.query.url : undefined,
        maxwidth: req.query.maxwidth,
        maxheight: req.query.maxheight,
        format: typeof req.query.format === 'string' ? req.query.format : undefined,
      });
      return res.status(200).json(data);
    } catch (error: any) {
      if (error.statusCode === 404) {
        return res.status(404).json({ success: false, message: error.message });
      }
      handleError(req, res, error);
    }
  };
}
