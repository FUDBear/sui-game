import { supabase } from './supabaseClient.js';
import { cardsDb } from './cardsDB.js';

export class PlayerService {
  // Get a player by their Google sub (user ID)
  static async getPlayer(googleSub) {
    console.log('🔍 Looking for player with googleSub:', googleSub);
    const { data, error } = await supabase
      .from('players')
      .select('*')
      .eq('google_sub', googleSub)
      .single();
    
    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
      console.error('Error fetching player:', error);
      throw error;
    }
    
    console.log('📋 Player data:', data);
    return data;
  }

  // Create a new player
  static async createPlayer(googleSub, playerData) {
    console.log('➕ Creating player with data:', { googleSub, ...playerData });
    const { data, error } = await supabase
      .from('players')
      .insert([{ google_sub: googleSub, ...playerData }])
      .select()
      .single();
    
    if (error) {
      console.error('Error creating player:', error);
      throw error;
    }
    
    console.log('✅ Player created successfully:', data);
    return data;
  }

  // Update a player
  static async updatePlayer(googleSub, updates) {
    const { data, error } = await supabase
      .from('players')
      .update(updates)
      .eq('google_sub', googleSub)
      .select()
      .single();
    
    if (error) {
      console.error('Error updating player:', error);
      throw error;
    }
    
    return data;
  }

  // Get all players (for admin/debug purposes)
  static async getAllPlayers() {
    const { data, error } = await supabase
      .from('players')
      .select('*');
    
    if (error) {
      console.error('Error fetching all players:', error);
      throw error;
    }
    
    return data;
  }

  // Initialize a new player with default state
  static async initializePlayer(googleSub) {
    const defaultState = {
      active_hand: [-1, -1, -1],
      hand: await this.generateRandomDeck(3),
      deck_count: 20,
      deck: await this.generateRandomDeck(20),
      reset_deck: true,
      madness: 0,
      state: 1,
      casts: 0,
      catch: null,
      utc_timestamp: Date.now()
    };

    return await this.createPlayer(googleSub, defaultState);
  }

  // Helper method to generate random deck
  static async generateRandomDeck(size = 20) {
    // re-read to get the latest data
    await cardsDb.read();

    // cardsDb.data.cards is an object: name → cardData
    const cardList = Object.values(cardsDb.data.cards);

    const deck = [];
    for (let i = 0; i < size; i++) {
      // pick a random card object
      const randomCard = 
        cardList[Math.floor(Math.random() * cardList.length)];
      // push its `index` field
      deck.push(randomCard.index);
    }
    return deck;
  }

  // Ensure a player exists, create if they don't
  static async ensurePlayer(googleSub) {
    let player = await this.getPlayer(googleSub);
    
    if (!player) {
      player = await this.initializePlayer(googleSub);
    }
    
    return player;
  }
} 